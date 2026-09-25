/**
 * Real openclaw.chat -> engine -> system-agent -> embedded admission proof.
 * The synthetic dispatch seam is reached only after real lane admission.
 */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run-orchestrator.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import {
  withPreparedModelRuntimePluginGenerationScope as scope,
  getPreparedModelRuntimePluginGeneration as current,
} from "../agents/prepared-model-runtime-generation-scope.js";
import {
  refreshPreparedModelRuntimeSnapshots,
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
} from "../agents/prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../agents/prepared-model-runtime.owner.js";
import { preparedPluginGenerationReusesBase } from "../agents/prepared-model-runtime.plugin-generation.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimePluginGeneration } from "../agents/prepared-model-runtime.types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createOpenClawDelegateToolsForRun } from "../agents/tools/openclaw-delegate-tool.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import type { SystemAgentChatSession } from "../gateway/server-methods/system-agent.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runSystemAgentTurnWithDeps } from "../system-agent/agent-turn.test-support.js";
import { SystemAgentChatEngine } from "../system-agent/chat-engine.js";
import type { SystemAgentOverview } from "../system-agent/overview.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../system-agent/system-agent.test-helpers.js";
import { createSystemAgentSession } from "./agent-turn.js";
import {
  planSystemAgentCommandWithConfiguredModel,
  planSystemAgentGreetingWithConfiguredModel,
} from "./assistant.js";
import { buildFacts } from "./runtime-admission.test-helpers.js";
type RunEmbeddedAgentParams = Parameters<typeof runEmbeddedAgent>[0];

vi.mock(
  "../agents/prepared-model-runtime.build.js",
  async () => (await import("./runtime-admission.test-helpers.js")).runtimeAdmissionBuildModule,
);
const state = vi.hoisted(() => ({
  acquisitionEntered: undefined as (() => void) | undefined,
  lateLeaseDisposed: undefined as (() => void) | undefined,
  terminal: [] as {
    main: number;
    inference: number;
    agentId?: string;
    workspaceDir: string;
    generation: PreparedModelRuntimePluginGeneration | undefined;
  }[],
  responseText: undefined as string | undefined,
  revokeAuthority: false,
  beforeEmbedded: undefined as (() => Promise<void>) | undefined,
  revokeCurrent: undefined as (() => void) | undefined,
  observedAmbient: [] as {
    ambient: PreparedModelRuntimePluginGeneration | undefined;
    explicit: PreparedModelRuntimePluginGeneration | undefined;
  }[],
}));
// Observe entry only after calling the real acquisition: publication and retention
// remain real, and initial verified-state resolution necessarily precedes this seam.
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/prepared-model-runtime.js")>();
  return {
    ...actual,
    acquirePublishedPreparedModelRuntime: (
      ...args: Parameters<typeof actual.acquirePublishedPreparedModelRuntime>
    ) => {
      const pending = actual.acquirePublishedPreparedModelRuntime(...args);
      const entered = state.acquisitionEntered;
      const disposed = state.lateLeaseDisposed;
      state.acquisitionEntered = undefined;
      state.lateLeaseDisposed = undefined;
      entered?.();
      return pending.then((lease) =>
        disposed
          ? {
              ...lease,
              [Symbol.asyncDispose]: async () => {
                await lease[Symbol.asyncDispose]();
                disposed();
              },
            }
          : lease,
      );
    },
  };
});

function observeAcquisition() {
  const entered = createDeferred();
  state.acquisitionEntered = () => entered.resolve();
  return entered.promise;
}
// This terminal is called by run-orchestrator AFTER REAL acquire and binding.
vi.mock("../agents/embedded-agent-runner/run-loop.js", () => ({
  runPreparedEmbeddedLoop: async (
    ...[_refresh, p]: Parameters<
      typeof import("../agents/embedded-agent-runner/run-loop.js").runPreparedEmbeddedLoop
    >
  ) => {
    if (
      p.runParams.runId?.startsWith("openclaw-planner") ||
      p.runParams.runId?.startsWith("openclaw-greeting")
    ) {
      expect(p.runParams.disableTools).toBe(true);
      expect(p.runParams.toolsAllow).toEqual([]);
    } else {
      expect(p.runParams.toolsAllow).toEqual(["openclaw"]);
    }
    // Model setup normally admits here, after the immutable generation guard.
    await expectDefined(p.runParams.preparedRunAdmission, "prepared admission").admit("embedded");
    state.terminal.push({
      main: getCommandLaneSnapshot(CommandLane.Main).activeCount,
      inference: getCommandLaneSnapshot(CommandLane.SystemAgentInference).activeCount,
      agentId: p.runParams.agentId,
      workspaceDir: p.runParams.workspaceDir,
      generation: current(),
    });
    return completedResult();
  },
}));
const RESPONSE_TEXT = "Synthetic expert response; no action was executed.";
vi.mock("../agents/embedded-agent-runner/cli-backend-dispatch.js", () => ({
  // This function is called inside run-orchestrator's admitted global-lane task.
  runEmbeddedAgentViaCliBackendIfEligible: async () => undefined,
}));
vi.mock("../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: vi.fn(),
  appendTranscriptReset: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

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
    state.acquisitionEntered = undefined;
    state.lateLeaseDisposed = undefined;
    state.beforeEmbedded = undefined;
    state.revokeCurrent = undefined;
    buildFacts.buildGate = undefined;
    state.revokeAuthority = false;
    state.responseText = undefined;
    buildFacts.derived = false;
    await resetPreparedModelRuntimeSnapshotsForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    cleanup();
  }),
);

function completedResult(): EmbeddedAgentRunResult {
  return {
    meta: { durationMs: 1, finalAssistantVisibleText: state.responseText ?? RESPONSE_TEXT },
  };
}

async function createConversation(hosted = true) {
  resetCommandQueueStateForTest();
  const root = tempDirs.make("openclaw-nested-inference-integration-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const config: OpenClawConfig = {
    agents: {
      entries: { coordinator: {}, researcher: {} },
      defaults: {
        systemAgent: { agentId: "coordinator" },
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
    runEmbeddedAgent: async (runnerParams: RunEmbeddedAgentParams) => {
      state.observedAmbient.push({ ambient: current(), explicit: runnerParams.pluginGeneration });
      await state.beforeEmbedded?.();
      return await runEmbeddedAgent({
        ...runnerParams,
      });
    },
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
        ownerKey: JSON.stringify(["researcher", "agent:researcher:proof"]),
      },
    ],
  ]);
  const invoke = (signal?: AbortSignal) =>
    metadata.run(
      () =>
        withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => config }, () => {
          const context = expectDefined(
            getPluginRuntimeGatewayRequestScope()?.context,
            "local Gateway context",
          );
          const freshEngine = new SystemAgentChatEngine(
            {
              surface: "gateway",
              verifiedInference: proof.binding,
              operatorApprovalOnly: true,
              deps,
              runAgentTurn: (params) => runSystemAgentTurnWithDeps(params, deps),
            },
            { executeOperation },
          );
          engines.push(freshEngine);
          sessions.set(sessionId, {
            engine: freshEngine,
            welcome: "Synthetic welcome",
            lastUsedAt: 1,
            ownerKey: JSON.stringify(["researcher", "agent:researcher:proof"]),
          });
          context.systemAgentSessions = sessions;
          const tool = createOpenClawDelegateToolsForRun({
            config,
            sessionAgentId: "researcher",
            runSessionKey: "agent:researcher:proof",
          })[0]!;
          const operationalRunInstance = createOperationalRunInstanceRef("proof-parent");
          const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
          if (state.revokeAuthority) {
            releaseAgentRunDelegatedAuthority(authority);
          }
          state.revokeCurrent = () => releaseAgentRunDelegatedAuthority(authority);
          return withGatewayToolCallerIdentity(
            {
              agentId: "researcher",
              sessionKey: "agent:researcher:proof",
              operationalRunInstance,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
            },
            () =>
              tool.execute(
                "synthetic-call",
                { sessionId, message: "Report status only; do not act." },
                signal,
              ),
          ).finally(() => releaseAgentRunDelegatedAuthority(authority));
        }),
      config,
    );
  buildFacts.metadata = metadata.bindForConfig(config);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: hosted,
    catalogMode: "static",
    pluginMetadataSnapshot: buildFacts.metadata,
  });
  const input = {
    config,
    agentId: "coordinator",
    agentDir: resolveAgentDir(config, "coordinator"),
    workspaceDir: resolveAgentWorkspaceDir(config, "coordinator"),
  };
  const published = await acquirePublishedPreparedModelRuntime(input);
  return { invoke, executeOperation, config, input, published, deps, proof, overview };
}

describe("hosted delegation selected-owner admission", () => {
  it.each(["planner", "greeting"] as const)(
    "admits %s from a derivative parent into a tool-free temporary workspace",
    async (kind) => {
      const c = await createConversation();
      await using published = c.published;
      buildFacts.derived = true;
      await using parent = await acquireAgentRunPreparedModelRuntime(
        { ...c.input, workspaceDir: c.input.workspaceDir + "-derivative" },
        {
          pluginGeneration: published.pluginGeneration,
          catalogMode: "static",
        },
      );
      buildFacts.derived = false;
      expect(parent.pluginGeneration).not.toBe(published.pluginGeneration);
      const before = state.terminal.length;
      state.responseText =
        kind === "planner" ? JSON.stringify({ reply: RESPONSE_TEXT }) : RESPONSE_TEXT;
      const result = await metadata.run(
        () =>
          scope(
            parent.pluginGeneration,
            () =>
              kind === "planner"
                ? planSystemAgentCommandWithConfiguredModel({
                    input: "status only",
                    overview: c.overview,
                    verifiedInference: c.proof.binding,
                    deps: c.deps,
                  })
                : planSystemAgentGreetingWithConfiguredModel({
                    overview: c.overview,
                    facts: {
                      updateAvailable: null,
                      channelHealth: { available: true, degraded: [] },
                      recentExternalEdit: false,
                      auditSequence: 0,
                    },
                    verifiedInference: c.proof.binding,
                    deps: c.deps,
                    timeoutMs: 10000,
                  }),
            () => parent.snapshot,
          ),
        c.config,
      );
      expect(result).toMatchObject(
        kind === "planner" ? { reply: RESPONSE_TEXT } : { text: RESPONSE_TEXT },
      );
      expect(state.terminal).toHaveLength(before + 1);
      expect(state.terminal.at(-1)?.generation).toBe(published.pluginGeneration);
      expect(state.terminal.at(-1)?.workspaceDir).not.toBe(parent.snapshot.workspaceDir);
    },
  );

  it("preserves standalone local admission without caller authority", async () => {
    const c = await createConversation(false);
    await using published = c.published;
    expect(published.snapshot.agentId).toBe("coordinator");
    const reply = await metadata.run(
      () =>
        runSystemAgentTurnWithDeps(
          {
            input: "status only",
            overview: c.overview,
            surface: "cli",
            approvalArmed: false,
            session: createSystemAgentSession(c.proof.binding),
          },
          c.deps,
        ),
      c.config,
    );
    expect(reply?.text).toBe(RESPONSE_TEXT);
  });

  it.each(["model", "auth", "binding", "authority"] as const)(
    "rejects %s changes across publication wait",
    async (change) => {
      const c = await createConversation();
      await using published = c.published;
      expect(published.snapshot.agentId).toBe("coordinator");
      const gate = createDeferred();
      buildFacts.buildGate = gate.promise;
      const publication = refreshPreparedModelRuntimeSnapshots(c.config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        pluginMetadataSnapshot: buildFacts.metadata,
      });
      const session = createSystemAgentSession(c.proof.binding);
      const before = state.terminal.length;
      const entered = observeAcquisition();
      const invoke =
        change === "binding"
          ? metadata.run(
              () =>
                runSystemAgentTurnWithDeps(
                  {
                    input: "status",
                    overview: c.overview,
                    surface: "gateway",
                    approvalArmed: false,
                    session,
                  },
                  c.deps,
                ),
              c.config,
            )
          : c.invoke();
      const check = expect(invoke).rejects.toThrow();
      try {
        await entered;
        if (change === "model") {
          c.config.agents!.defaults!.model = "openai/different";
        } else if (change === "auth") {
          c.config.auth = {
            profiles: { "openai:changed": { provider: "openai", mode: "api_key" } },
          };
        } else if (change === "binding") {
          session.verifiedInference = { ...c.proof.binding };
        } else {
          expectDefined(state.revokeCurrent, "caller revocation")();
        }
      } finally {
        buildFacts.buildGate = undefined;
        gate.resolve();
        await publication;
      }
      await check;
      expect(state.terminal).toHaveLength(before);
    },
  );

  it("fails closed on reload after selected lease before embedded acquisition", async () => {
    const c = await createConversation();
    await using published = c.published;
    expect(published.snapshot.agentId).toBe("coordinator");
    state.beforeEmbedded = async () => {
      state.beforeEmbedded = undefined;
      await refreshPreparedModelRuntimeSnapshots(c.config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        pluginMetadataSnapshot: buildFacts.metadata,
      });
    };
    const before = state.terminal.length;
    await expect(c.invoke()).rejects.toThrow("superseded");
    expect(state.terminal).toHaveLength(before);
  });

  it("rejects caller revocation after selected lease before embedded admission", async () => {
    const c = await createConversation();
    await using published = c.published;
    expect(published.snapshot.agentId).toBe("coordinator");
    state.beforeEmbedded = async () => {
      state.beforeEmbedded = undefined;
      expectDefined(state.revokeCurrent, "caller revocation")();
    };
    const before = state.terminal.length;
    await expect(c.invoke()).rejects.toThrow("caller authority is no longer active");
    expect(state.terminal).toHaveLength(before);
  });

  it("rejects an already cancelled delegated tool without inference", async () => {
    const c = await createConversation();
    await using published = c.published;
    expect(published.snapshot.agentId).toBe("coordinator");
    const controller = new AbortController();
    controller.abort();
    const before = state.terminal.length;
    await expect(c.invoke(controller.signal)).rejects.toThrow(/abort|authority/i);
    expect(state.terminal).toHaveLength(before);
  });

  it("exact configured control versus active derivative cross-agent inheritance", async () => {
    state.terminal.length = 0;
    const c = await createConversation();
    await using published = c.published;
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(c.published.snapshot)!;
    expect(owner.needsRefresh).toBe(false);
    const base = c.published.pluginGeneration;
    await enqueueCommandInLane(CommandLane.Main, () =>
      scope(
        base,
        () => c.invoke(),
        () => published.snapshot,
      ),
    );
    expect(state.terminal).toHaveLength(1);
    expect(expectDefined(state.terminal[0], "terminal").agentId).toBe("openclaw");
    expect(expectDefined(state.terminal[0], "terminal").main).toBe(1);
    expect(expectDefined(state.terminal[0], "terminal").inference).toBe(1);
    expect(expectDefined(state.terminal[0], "terminal").workspaceDir).not.toBe(
      c.input.workspaceDir,
    );
    buildFacts.derived = true;
    const parentInput = {
      ...c.input,
      workspaceDir: c.input.workspaceDir + "-parent-derived",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", agentId: "coordinator" }],
    };
    await using parent = await acquireAgentRunPreparedModelRuntime(parentInput, {
      pluginGeneration: base,
      catalogMode: "static",
    });
    buildFacts.derived = false;
    expect(parent.pluginGeneration).not.toBe(base);
    expect(preparedPluginGenerationReusesBase(parent.pluginGeneration, base)).toBe(true);
    const matchingBorrow = await scope(
      parent.pluginGeneration,
      () =>
        acquireAgentRunPreparedModelRuntime(parentInput, {
          pluginGeneration: parent.pluginGeneration,
          catalogMode: "static",
        }),
      () => parent.snapshot,
    );
    expect(matchingBorrow.snapshot).toBe(parent.snapshot);
    await matchingBorrow[Symbol.asyncDispose]();
    await expect(
      scope(
        parent.pluginGeneration,
        () =>
          acquireAgentRunPreparedModelRuntime(
            { ...parentInput, agentId: "openclaw" },
            { pluginGeneration: parent.pluginGeneration, catalogMode: "static" },
          ),
        () => parent.snapshot,
      ),
    ).rejects.toThrow("superseded");
    const before = state.terminal.length;
    await using callerLease = await acquirePublishedPreparedModelRuntime({
      config: c.config,
      agentId: "researcher",
      agentDir: resolveAgentDir(c.config, "researcher"),
      workspaceDir: resolveAgentWorkspaceDir(c.config, "researcher"),
    });
    expect(callerLease.pluginGeneration).not.toBe(base);
    const fixed = await enqueueCommandInLane(CommandLane.Main, () =>
      scope(
        parent.pluginGeneration,
        () => c.invoke(),
        () => parent.snapshot,
      ),
    );
    expect(fixed.details).toMatchObject({ reply: RESPONSE_TEXT });
    expect(state.terminal).toHaveLength(before + 1);
    expect(expectDefined(state.terminal.at(-1), "terminal").agentId).toBe("openclaw");
    expect(expectDefined(state.terminal.at(-1), "terminal").workspaceDir).not.toBe(
      parent.snapshot.workspaceDir,
    );
    expect(expectDefined(state.terminal.at(-1), "terminal").generation).toBe(base);
    expect(expectDefined(state.terminal.at(-1), "terminal").inference).toBe(1);
    expect(expectDefined(state.terminal.at(-1), "terminal").main).toBe(1);
    expect(expectDefined(state.observedAmbient.at(-1), "ambient").ambient).toBe(
      parent.pluginGeneration,
    );
    expect(expectDefined(state.observedAmbient.at(-1), "ambient").explicit).toBe(base);
    const crossOwner = await scope(
      callerLease.pluginGeneration,
      () => c.invoke(),
      () => callerLease.snapshot,
    );
    expect(crossOwner.details).toMatchObject({ reply: RESPONSE_TEXT });
    expect(expectDefined(state.terminal.at(-1), "terminal").generation).toBe(base);
    expect(expectDefined(state.terminal.at(-1), "terminal").agentId).toBe("openclaw");
    const expired = await scope(
      parent.pluginGeneration,
      () => c.invoke(),
      () => undefined,
    );
    expect(expired.details).toMatchObject({ reply: RESPONSE_TEXT });
    // A true stale owner is not masked by this candidate.
    owner.needsRefresh = true;
    await expect(
      scope(
        parent.pluginGeneration,
        () => c.invoke(),
        () => parent.snapshot,
      ),
    ).rejects.toThrow("refresh is pending");
    owner.needsRefresh = false;
    // Genuine pending lifecycle publication; child must not reach terminal while waiting.
    const gate = createDeferred();
    buildFacts.buildGate = gate.promise;
    const pending = refreshPreparedModelRuntimeSnapshots(c.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: buildFacts.metadata,
    });
    const terminalBeforeWait = state.terminal.length;
    const entered = observeAcquisition();
    const waiting = scope(
      parent.pluginGeneration,
      () => c.invoke(),
      () => parent.snapshot,
    );
    try {
      await entered;
      expect(state.terminal).toHaveLength(terminalBeforeWait);
    } finally {
      buildFacts.buildGate = undefined;
      gate.resolve();
      await pending;
    }
    const resumed = await waiting;
    expect(resumed.details).toMatchObject({ reply: RESPONSE_TEXT });
    expect(state.terminal).toHaveLength(terminalBeforeWait + 1);
    expect(expectDefined(state.terminal.at(-1), "terminal").generation).not.toBe(base);
    expect(expectDefined(state.terminal.at(-1), "terminal").agentId).toBe("openclaw");
    const cancelGate = createDeferred();
    buildFacts.buildGate = cancelGate.promise;
    const cancelPublication = refreshPreparedModelRuntimeSnapshots(c.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: buildFacts.metadata,
    });
    const controller = new AbortController();
    const cancelEntered = observeAcquisition();
    const lateDisposed = createDeferred();
    state.lateLeaseDisposed = () => lateDisposed.resolve();
    const cancelled = scope(
      parent.pluginGeneration,
      () => c.invoke(controller.signal),
      () => parent.snapshot,
    );
    const cancelCheck = expect(cancelled).rejects.toThrow(/abort|authority/i);
    try {
      await cancelEntered;
      controller.abort();
      // Observe caller settlement while publication is still held.
      await cancelCheck;
      expect(state.terminal).toHaveLength(terminalBeforeWait + 1);
    } finally {
      buildFacts.buildGate = undefined;
      cancelGate.resolve();
      await cancelPublication;
    }
    await lateDisposed.promise;
    const afterCancel = state.terminal.length;
    // A subsequent successful admission and final lifecycle close detect leaked late retention.
    await scope(
      parent.pluginGeneration,
      () => c.invoke(),
      () => parent.snapshot,
    );
    expect(state.terminal).toHaveLength(afterCancel + 1);
    // Explicit selected owner admission cannot resurrect revoked tool authority.
    state.revokeAuthority = true;
    const terminalBeforeRevoked = state.terminal.length;
    await expect(
      scope(
        parent.pluginGeneration,
        () => c.invoke(),
        () => parent.snapshot,
      ),
    ).rejects.toThrow("caller authority is no longer active");
    state.revokeAuthority = false;
    expect(state.terminal).toHaveLength(terminalBeforeRevoked);
    // Failed replacement keeps child closed; no synthetic response is possible.
    const failGate = createDeferred();
    buildFacts.buildGate = failGate.promise;
    const failedPublication = refreshPreparedModelRuntimeSnapshots(c.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: buildFacts.metadata,
    });
    const failEntered = observeAcquisition();
    const failedChild = scope(
      parent.pluginGeneration,
      () => c.invoke(),
      () => parent.snapshot,
    );
    const checks = [
      expect(failedPublication).rejects.toThrow("synthetic build failure"),
      expect(failedChild).rejects.toThrow("synthetic build failure"),
    ];
    try {
      await failEntered;
      expect(state.terminal).toHaveLength(terminalBeforeRevoked);
    } finally {
      buildFacts.buildGate = undefined;
      failGate.reject(new Error("synthetic build failure"));
      await Promise.all(checks);
    }
    expect(state.terminal).toHaveLength(terminalBeforeRevoked);
    expect(c.executeOperation).not.toHaveBeenCalled();
  }, 90000);
});
