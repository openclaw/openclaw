/**
 * Real openclaw.chat -> engine -> system-agent -> embedded admission proof.
 * The synthetic dispatch seam is reached only after real lane admission.
 */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run-orchestrator.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  listCommandLaneTotals,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runSystemAgentTurnWithDeps } from "../../system-agent/agent-turn.test-support.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import type { SystemAgentOverview } from "../../system-agent/overview.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient } from "./types.js";

const RESPONSE_TEXT = "Synthetic expert response; no action was executed.";
const dispatch = vi.hoisted(() =>
  vi.fn<(params: RunEmbeddedAgentParams) => Promise<EmbeddedAgentRunResult>>(),
);

vi.mock("../../agents/embedded-agent-runner/cli-backend-dispatch.js", () => ({
  // This function is called inside run-orchestrator's admitted global-lane task.
  runEmbeddedAgentViaCliBackendIfEligible: dispatch,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: vi.fn(),
  appendTranscriptReset: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
vi.mock("../../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

const client: GatewayClient = {
  connId: "nested-inference-test-connection",
  connect: {
    minProtocol: 4,
    maxProtocol: 4,
    client: { id: "cli", version: "test", platform: "test", mode: "cli" },
    role: "operator",
  },
};
let metadata: SystemAgentPluginMetadataTestSnapshot;
const engines: SystemAgentChatEngine[] = [];

beforeAll(() => {
  metadata = createSystemAgentPluginMetadataTestSnapshot();
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.dispose();
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    cleanup();
  }),
);

function completedResult(): EmbeddedAgentRunResult {
  return { meta: { durationMs: 1, finalAssistantVisibleText: RESPONSE_TEXT } };
}

async function createConversation() {
  resetCommandQueueStateForTest();
  const root = tempDirs.make("openclaw-nested-inference-integration-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const proof = await metadata.run(
    () => createSystemAgentVerifiedInferenceTestFixture(config),
    config,
  );
  const readConfigFileSnapshot = async (): Promise<ConfigFileSnapshot> => ({
    exists: true,
    valid: true,
    path: path.join(root, "synthetic-config.json"),
    hash: "synthetic-config-hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    parsed: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  const observed = createDeferred<"waiting" | "dispatched">();
  const captured: {
    mainActiveAtDispatch?: number;
    inferenceActiveAtDispatch?: number;
  } = {};
  dispatch.mockImplementation(async (params) => {
    captured.mainActiveAtDispatch = getCommandLaneSnapshot(CommandLane.Main).activeCount;
    captured.inferenceActiveAtDispatch = getCommandLaneSnapshot(
      CommandLane.SystemAgentInference,
    ).activeCount;
    await expectDefined(params.preparedRunAdmission, "prepared admission").admit("embedded");
    observed.resolve("dispatched");
    return completedResult();
  });
  const overview: SystemAgentOverview = {
    config: {
      path: path.join(root, "synthetic-config.json"),
      exists: true,
      valid: true,
      issues: [],
      hash: "synthetic-config-hash",
    },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
  const deps = {
    ...proof.deps,
    readConfigFileSnapshot,
    loadOverview: async () => overview,
    runEmbeddedAgent: async (runnerParams: RunEmbeddedAgentParams) =>
      await runEmbeddedAgent({
        ...runnerParams,
        onLaneWait: (wait) => {
          if (wait.waiting) {
            observed.resolve("waiting");
          }
        },
      }),
  };
  const executeOperation = vi.fn(async () => {
    throw new Error("external operation");
  });
  const engine = new SystemAgentChatEngine(
    {
      surface: "gateway",
      verifiedInference: proof.binding,
      operatorApprovalOnly: true,
      deps,
      runAgentTurn: (params) => runSystemAgentTurnWithDeps(params, deps),
    },
    { executeOperation },
  );
  engines.push(engine);
  const sessionId = "nested-inference-integration-conversation";
  const sessions = new Map<string, SystemAgentChatSession>([
    [
      sessionId,
      {
        engine,
        welcome: "Synthetic welcome",
        lastUsedAt: 1,
        ownerKey: "connection:nested-inference-test-connection",
      },
    ],
  ]);
  const respond = vi.fn();
  const invoke = () =>
    metadata.run(
      () =>
        withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => config }, () => {
          const context = expectDefined(
            getPluginRuntimeGatewayRequestScope()?.context,
            "local Gateway context",
          );
          context.systemAgentSessions = sessions;
          const params = { sessionId, message: "What is the next setup step?" };
          return systemAgentHandlers["openclaw.chat"]!({
            req: { type: "req", id: "nested-inference", method: "openclaw.chat", params },
            params,
            client,
            context,
            isWebchatConnect: () => false,
            respond,
          });
        }),
      config,
    );
  const greet = () =>
    metadata.run(
      () =>
        engine.planGreeting({
          overview,
          facts: {
            updateAvailable: null,
            channelHealth: { available: true, degraded: [] },
            recentExternalEdit: false,
            auditSequence: 0,
          },
          timeoutMs: 20_000,
        }),
      config,
    );
  return { captured, invoke, greet, observed, respond, executeOperation };
}

describe("system-agent nested inference through real Gateway admission", () => {
  it.each(["chat", "greeting"] as const)(
    "completes %s while its parent occupies the only main slot",
    async (entry) => {
      const conversation = await createConversation();
      expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(1);
      const releaseParent = createDeferred();
      const handlerStarted = createDeferred();
      let handler: Promise<unknown> | undefined;
      const parent = enqueueCommandInLane(CommandLane.Main, async () => {
        handler = Promise.resolve(entry === "chat" ? conversation.invoke() : conversation.greet());
        handlerStarted.resolve();
        await Promise.race([handler, releaseParent.promise]);
      });
      await handlerStarted.promise;
      if (!handler) {
        throw new Error("gateway handler did not start");
      }
      try {
        const observation = await withTestTimeout(
          conversation.observed.promise,
          2_000,
          "fixture did not reach the real runner admission boundary",
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const snapshot = {
          observation,
          main: getCommandLaneSnapshot(CommandLane.Main),
          inference: getCommandLaneSnapshot(CommandLane.SystemAgentInference),
          dispatchCount: dispatch.mock.calls.length,
        };
        // The repair changes this from waiting/queued-on-main to dispatched on
        // the dedicated inference lane while main remains occupied.
        expect(observation, JSON.stringify(snapshot)).toBe("dispatched");
        expect(snapshot.main.queuedCount).toBe(0);
        expect(snapshot.inference.queuedCount).toBe(0);
        expect(snapshot.dispatchCount).toBe(1);
        expect(conversation.captured.mainActiveAtDispatch).toBe(1);
        expect(conversation.captured.inferenceActiveAtDispatch).toBe(1);
        await parent;
        if (entry === "chat") {
          expect(conversation.respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({ reply: RESPONSE_TEXT, action: "none" }),
            undefined,
          );
        } else {
          expect(await handler).toMatchObject({ text: RESPONSE_TEXT });
        }
        expect(conversation.executeOperation).not.toHaveBeenCalled();
        expect(
          listCommandLaneTotals().filter((lane) => lane.activeCount || lane.queuedCount),
        ).toEqual([]);
      } finally {
        releaseParent.resolve();
        await parent;
        await handler;
      }
    },
  );
});
