import { afterEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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
    await Promise.all([
      client.request("health", { probe: true }),
      client.request("chat.metadata", {}),
      client.request("worktrees.branches", { repoRoot: workspaceDir }),
    ]);

    const contextModule = await import("../agents/context.js");
    resetContextWindowCacheForTest();

    const { getPublishedPreparedModelCatalogOwnerSnapshot } =
      await import("../agents/prepared-model-catalog.js");
    const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
      config: warmConfig,
      allowGatewaySubagentBinding: true,
    });
    if (!owner) {
      throw new Error("published model catalog is missing");
    }
    let processedThisTurn = 0;
    const batches: number[] = [];
    const inventories: Array<{ id: string }[]> = [
      ...Object.values(owner.config.models?.providers ?? {}).map((provider) => provider.models),
      owner.modelCatalog.entries,
      owner.modelCatalog.staticEntries ?? [],
    ];
    // Count real input consumption, so runner scheduling cannot inflate the work budget.
    for (const rows of new Set(inventories)) {
      vi.spyOn(rows, Symbol.iterator).mockImplementation(() => {
        const iterator = rows.values();
        const next = iterator.next.bind(iterator);
        iterator.next = () => {
          const result = next();
          if (!result.done) {
            processedThisTurn += 1;
          }
          return result;
        };
        return iterator;
      });
    }
    const heartbeat = () => {
      batches.push(processedThisTurn);
      processedThisTurn = 0;
      heartbeatHandle = setImmediate(heartbeat);
    };
    let heartbeatHandle = setImmediate(heartbeat);
    try {
      await Promise.all([
        contextModule
          .prewarmContextWindowCacheAfterReady({ config: warmConfig })
          .finally(() => clearImmediate(heartbeatHandle)),
        ...(["healthz", "readyz"] as const).map(async (name) => {
          const response = await fetch(`http://127.0.0.1:${port}/${name}`);
          expect(response.status).toBe(200);
          await response.arrayBuffer();
        }),
        client.request("health", { probe: true }),
        client.request("chat.metadata", {}),
        client.request("worktrees.branches", { repoRoot: workspaceDir }),
      ]);
    } finally {
      clearImmediate(heartbeatHandle);
      batches.push(processedThisTurn);
    }

    const caches = getContextWindowCaches();
    expect(caches.discoveredTokenCache.size).toBeGreaterThan(modelCount * 2);
    expect(batches.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(
      modelCount * 4,
    );
    expect(Math.max(...batches)).toBeLessThanOrEqual(512);
  };
  await runQaGatewayFixture(
    runProof,
    () => disconnectClient?.(),
    () => server.close({ reason: "context prewarm remote proof complete" }),
  );
}, 120_000);
