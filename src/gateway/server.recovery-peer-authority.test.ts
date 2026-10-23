import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createOpenClawCodingToolsAsync } from "../agents/agent-tools.js";
import { withPreparedEmbeddedGatewayTools } from "../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../agents/embedded-agent-runner/run/types.js";
import { seedConsumedPeerRestartInput } from "../agents/main-session-recovery/main-session-restart-recovery-peer-source.test-support.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { isMissingPathError } from "../infra/errors.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "./test-helpers.js";

const runAttempt = vi.hoisted(() =>
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>(),
);

// mock-isolation: Replace inference only; Gateway admission, command ownership, tools and I/O stay real.
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runAttempt,
}));

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  },
  cleanup: () => harness?.close(),
});

it.for(["allowed", "revoked"] as const)(
  "consumed peer recovery checks restored permission at a retained tool write: %s",
  async (permission, { signal }) => {
    const stateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated Gateway state");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const workspaceDir = path.join(stateDir, `peer-recovery-workspace-${permission}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { entries: { main: {} } };
    testState.agentConfig = {
      model: { primary: "peer-fixture/mock-1" },
      workspace: workspaceDir,
      thinkingDefault: "off",
      compaction: { enabled: false },
    };
    const config = getRuntimeConfig();
    const { api, baseUrl, provider, ...model } = makeProviderModelFixture<"openai-responses">({
      id: "mock-1",
      name: "Peer recovery fixture",
      provider: "peer-fixture",
      api: "openai-responses",
      baseUrl: "https://peer-recovery.example.test/v1",
      maxTokens: 2_048,
    });
    await writeConfigFile({
      ...config,
      session: {
        ...config.session,
        store: storePath,
        communication: { send: "always", receive: "always" },
      },
      tools: { ...config.tools, allow: ["write"], sessions: { visibility: "all" } },
      plugins: { ...config.plugins, enabled: false },
      models: {
        providers: {
          [provider]: {
            api,
            apiKey: "synthetic-peer-recovery-key",
            baseUrl,
            models: [model],
          },
        },
      },
    });
    const discovery = await import("../agents/agent-model-discovery.js");
    const actualDiscovery = await vi.importActual<typeof discovery>(
      "../agents/agent-model-discovery.js",
    );
    const discoverySpy = vi
      .spyOn(discovery, "discoverModelsAsync")
      .mockImplementation(actualDiscovery.discoverModelsAsync);
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const cfg = kernel.gatewayRequestContext.getRuntimeConfig();
    const identity = (role: "source" | "target") => ({
      agentId: "main",
      sessionKey: `agent:main:recovery-${role}-${permission}`,
      sessionId: `recovery-${role}-${permission}`,
      lifecycleRevision: `${role}-generation-${permission}`,
      storePath,
    });
    const source = identity("source");
    const target = identity("target");
    const { receiver } = await seedConsumedPeerRestartInput({
      cfg,
      source,
      target,
      runId: `consumed-peer-${permission}`,
    });
    const command = await import("../agents/agent-command.js");
    agentCommandMock.mockImplementation((...args) =>
      command.agentCommandFromGatewayIngress(
        ...(args as Parameters<typeof command.agentCommandFromGatewayIngress>),
      ),
    );
    const toolReady = createDeferred();
    const releaseTool = createDeferred();
    const dispatchFinished = createDeferred<unknown>();
    void dispatchFinished.promise.catch(() => undefined);
    const effectFile = path.join(workspaceDir, "recovered-effect.txt");
    let didDispatch = false;
    let attempted = false;
    let effectError: unknown;
    runAttempt.mockImplementation(async (attempt) =>
      withPreparedEmbeddedGatewayTools(
        {
          ...attempt,
          agentId: expectDefined(attempt.agentId, "recovered agent"),
          sessionKey: expectDefined(attempt.sessionKey, "recovered session"),
          agentHarnessId: "openclaw",
        },
        async () => {
          const tools = await createOpenClawCodingToolsAsync({
            agentId: attempt.agentId,
            sessionKey: attempt.sessionKey,
            sessionId: attempt.sessionId,
            runId: attempt.runId,
            workspaceDir,
            config: attempt.config,
            abortSignal: attempt.abortSignal,
          });
          const write = expectDefined(
            tools.find((tool) => tool.name === "write"),
            "real write tool",
          );
          toolReady.resolve();
          await withinTest(releaseTool.promise, signal);
          attempted = true;
          try {
            await write.execute("recovered-write", {
              path: effectFile,
              content: "recovered peer effect\n",
            });
          } catch (error) {
            effectError = error;
            throw error;
          }
          const assistant = buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "Recovered task completed." }],
          });
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: attempt.sessionId,
            lastAssistant: assistant,
            assistantTexts: ["Recovered task completed."],
            messagesSnapshot: [assistant],
          });
        },
      ),
    );
    const actualRuntime = kernel.gatewayInstanceRuntime.recovery;
    const runtime: GatewayRecoveryRuntime = {
      ...actualRuntime,
      dispatchAgent: async <T>(...args: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>) => {
        didDispatch = true;
        const dispatched = actualRuntime.dispatchAgent<T>(...args);
        void dispatched.then(dispatchFinished.resolve, dispatchFinished.reject);
        return dispatched;
      },
    };
    const recovery = recoverStore({
      storeAgentId: "main",
      storePath,
      cfg,
      handledSessionKeys: new Set(),
      gatewayRuntime: runtime,
    });
    try {
      expect(await withinTest(recovery, signal)).toMatchObject({ started: 1, failed: 0 });
      await withinTest(
        awaitGateBeforeSettlement(
          toolReady.promise,
          dispatchFinished.promise,
          "recovery ended before tool construction",
        ),
        signal,
      );
      if (permission === "revoked") {
        await updateSessionEntry(source, () => ({ communication: { send: "never" } }));
      }
      releaseTool.resolve();
      await withinTest(
        dispatchFinished.promise.catch(() => undefined),
        signal,
      );
      expect(attempted).toBe(true);
      const effect = await fs.readFile(effectFile, "utf8").catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return undefined;
        }
        throw error;
      });
      if (permission === "allowed") {
        expect({ effectError, effect }).toEqual({
          effectError: undefined,
          effect: "recovered peer effect\n",
        });
      } else {
        expect(effect).toBeUndefined();
        expect(effectError).toBeDefined();
      }
      expect(receiver).toHaveBeenCalledOnce();
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
    } finally {
      releaseTool.resolve();
      await Promise.allSettled([recovery, ...(didDispatch ? [dispatchFinished.promise] : [])]);
      discoverySpy.mockRestore();
    }
  },
);
