import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getContextWindowCaches } from "../agents/context-cache.js";
import { resetContextWindowCacheForTest } from "../agents/context.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { initializeManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

installGatewayTestHooks();
const repositories = createTempDirTracker();

afterEach(async () => {
  resetContextWindowCacheForTest();
  await resetPreparedModelRuntimeSnapshotsForTest();
  repositories.cleanup();
});

it("keeps unrelated work responsive during the real post-ready warmup", async () => {
  const modelCount = Number.parseInt(process.env.SYNTHETIC_MODEL_COUNT ?? "2000", 10);
  const makeProvider = (provider: string, port: number, baseWindow: number) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions" as const,
    models: Array.from({ length: modelCount }, (_, index) => ({
      id: index === 0 ? "shared-model" : `${provider}-model-${index}`,
      name: `${provider} model ${index}`,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: baseWindow + (index % 17),
      maxTokens: 8_192,
    })),
  });
  const token = "context-prewarm-proof-token";
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const { port } = portClaim;
  const server = await startTestGatewayServer(portClaim, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  let disconnectClient: (() => Promise<void>) | undefined;
  const runProof = async () => {
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientDisplayName: "context-prewarm-proof",
      requestTimeoutMs: 10_000,
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    disconnectClient = () => disconnectGatewayClient(client);
    const workspaceDir = await initializeManagedWorktreeTestRepository(
      repositories.make("openclaw-context-prewarm-"),
    );
    const warmConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: "synthetic-a/shared-model" },
          models: {
            "synthetic-a/shared-model": { agentRuntime: { id: "openclaw" } },
            "synthetic-b/shared-model": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      models: {
        providers: {
          "synthetic-a": makeProvider("synthetic-a", 1, 128_000),
          "synthetic-b": makeProvider("synthetic-b", 2, 64_000),
        },
      },
    } satisfies OpenClawConfig;
    const { refreshPreparedModelRuntimeSnapshots } =
      await import("../agents/prepared-model-runtime.js");
    await refreshPreparedModelRuntimeSnapshots(warmConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const { getPublishedPreparedModelCatalogOwnerSnapshot } =
      await import("../agents/prepared-model-catalog.js");
    const publishedOwner = getPublishedPreparedModelCatalogOwnerSnapshot({
      config: structuredClone(warmConfig),
      allowGatewaySubagentBinding: true,
    });
    if (!publishedOwner) {
      throw new Error("synthetic Gateway model catalog owner was not published");
    }
    await Promise.all([
      client.request("health", { probe: true }),
      client.request("chat.metadata", {}),
      client.request("worktrees.branches", { repoRoot: workspaceDir }),
    ]);

    const contextModule = await import("../agents/context.js");
    resetContextWindowCacheForTest();

    const heartbeatGaps: number[] = [];
    let lastHeartbeatAt = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      heartbeatGaps.push(now - lastHeartbeatAt);
      lastHeartbeatAt = now;
    }, 20);
    const latencies: Record<string, number[]> = {};
    const errors: string[] = [];
    const probe = async (name: string, run: () => Promise<unknown>) => {
      const startedAt = performance.now();
      try {
        await run();
      } catch (error) {
        errors.push(`${name}:${String(error)}`);
      } finally {
        (latencies[name] ??= []).push(performance.now() - startedAt);
      }
    };
    let probing = true;

    const activeContextPreparation = contextModule.prewarmContextWindowCacheAfterReady({
      config: warmConfig,
    });
    const probeLoop = (async () => {
      while (true) {
        await Promise.all([
          ...(["healthz", "readyz"] as const).map(async (name) => {
            await probe(name, async () => {
              const response = await fetch(`http://127.0.0.1:${port}/${name}`);
              if (response.status !== 200) {
                errors.push(`${name}:${response.status}`);
              }
              await response.arrayBuffer();
            });
          }),
          probe("healthRpc", () => client.request("health", { probe: true })),
          probe("metadataRpc", () => client.request("chat.metadata", {})),
          probe("branchesRpc", () =>
            client.request("worktrees.branches", { repoRoot: workspaceDir }),
          ),
        ]);
        if (!probing) {
          break;
        }
        await delay(40);
      }
    })();
    const contextPreparationOutcome = await activeContextPreparation.then(
      () => ({ status: "loaded" as const }),
      (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
    );
    await delay(100);
    probing = false;
    await probeLoop;
    await delay(40);
    clearInterval(heartbeat);

    const resolveTokens = (provider?: string) =>
      contextModule.resolveContextTokensForModel({
        cfg: provider ? warmConfig : {},
        provider,
        model: "shared-model",
        allowAsyncLoad: false,
      });
    const caches = getContextWindowCaches();
    expect(errors).toEqual([]);
    expect(contextPreparationOutcome).toEqual({ status: "loaded" });
    expect([resolveTokens(), resolveTokens("synthetic-a"), resolveTokens("synthetic-b")]).toEqual([
      64_000, 128_000, 64_000,
    ]);
    expect(caches.discoveredTokenCache.size).toBeGreaterThan(modelCount * 2);
    expect(caches.contextWindowCache.size).toBeGreaterThan(modelCount * 2);
    expect(Math.max(...heartbeatGaps)).toBeLessThan(500);
    for (const samples of Object.values(latencies)) {
      expect(Math.max(...samples)).toBeLessThan(1_000);
    }
  };
  await runQaGatewayFixture(
    runProof,
    () => disconnectClient?.(),
    () => server.close({ reason: "context prewarm remote proof complete" }),
  );
}, 120_000);
