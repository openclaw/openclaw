// Register fixture mocks before importing the Gateway handlers that consume them.
// oxfmt-ignore
import { subagentRegistryMocks } from "./agent.subagent-registry.mocks.test-support.js";
import { vi } from "vitest";
import type { readAcpSessionMetaAsync } from "../../acp/runtime/session-meta.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime.types.js";
import type {
  SessionTranscriptReadScope,
  recordSessionParticipant,
  listSessionParticipantsReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";
import type { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { readTranscriptMutationStateInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createSessionAccessorMockReset } from "./agent.session-accessor-fixtures.test-support.js";
import { createAgentTestUserTurnRecorder } from "./agent.user-turn-recorder.test-support.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  applySessionEntryReplacements: vi.fn(),
  patchSessionEntryTarget: vi.fn(),
  resetSessionEntryLifecycle: vi.fn<typeof resetSessionEntryLifecycle>(),
  persistSessionTranscriptTurn: vi.fn(),
  stageSessionPendingInput: vi.fn<typeof stageSessionPendingInput>(),
  recordSessionParticipant: vi.fn<typeof recordSessionParticipant>(async () => "inserted"),
  listSessionParticipantsReadOnly: vi.fn<typeof listSessionParticipantsReadOnly>(() => new Map()),
  hasSessionTranscriptEventsSync: vi.fn<(scope: SessionTranscriptReadScope) => boolean>(
    () => false,
  ),
  readTranscriptMutationStateSync: vi.fn<
    (
      scope: SessionTranscriptReadScope,
    ) => ReturnType<typeof readTranscriptMutationStateInTransaction>
  >(() => ({
    observedAt: null,
    updatedAt: null,
  })),
  agentCommand: vi.fn(),
  agentCommandListeners: new Set<() => void>(),
  clearAgentRunContext: vi.fn(),
  registerAgentRunContext: vi.fn(),
  emitAgentEvent: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  emitGatewaySessionEndPluginHook: vi.fn(),
  emitGatewaySessionStartPluginHook: vi.fn(),
  getLatestSubagentRunByChildSessionKey: vi.fn(),
  getLatestLiveSubagentRunByChildSessionKey:
    vi.fn<
      typeof import("../../agents/subagents/registry/subagent-registry-read.js").getLatestLiveSubagentRunByChildSessionKey
    >(),
  replaceSubagentRunAfterSteer: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
  resolveAgentExplicitRecipientSession: vi.fn(async () => ({})),
  readAcpSessionMetaAsync: vi.fn<typeof readAcpSessionMetaAsync>(async () => undefined),
  listAgentIds: vi.fn(() => ["main"]),
  loadConfigReturn: {} as OpenClawConfig,
  userTurnStorePath: undefined as string | undefined,
  loadVoiceWakeRoutingConfig: vi.fn(),
  resolveVoiceWakeRouteByTrigger: vi.fn(),
  getChannelPlugin: vi.fn(),
  sendDurableMessageBatch: vi.fn(),
  resolveSendPolicy: vi.fn((_args?: { entry?: { sendPolicy?: string } }) => "allow"),
  resolveSessionLifecycleTimestamps: vi.fn(
    ({ entry }: { entry?: { sessionStartedAt?: number; lastInteractionAt?: number } }) => ({
      sessionStartedAt: entry?.sessionStartedAt,
      lastInteractionAt: entry?.lastInteractionAt,
    }),
  ),
  lifecycleGeneration: "test-generation",
}));

const agentTestMocks = Object.assign(mocks, subagentRegistryMocks);

export function getAgentTestMocks() {
  return agentTestMocks;
}

export function resolveAgentTestConfig(
  cfg: OpenClawConfig = mocks.loadConfigReturn,
): OpenClawConfig {
  if (cfg.agents?.entries) {
    return cfg;
  }
  const agentIds = mocks.listAgentIds();
  if (agentIds.length === 1 && agentIds[0] === "main") {
    return cfg;
  }
  const resolved = {
    ...cfg,
    agents: {
      ...cfg.agents,
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
  if (cfg === mocks.loadConfigReturn) {
    mocks.loadConfigReturn = resolved;
  }
  return resolved;
}

function loadAgentSessionFixture(
  ...args: Parameters<typeof import("../session-entry-load.test-support.js").loadSessionEntryAsync>
): Awaited<
  ReturnType<typeof import("../session-entry-load.test-support.js").loadSessionEntryAsync>
> {
  const loaded = mocks.loadSessionEntry(...args) as Awaited<
    ReturnType<typeof import("../session-entry-load.test-support.js").loadSessionEntryAsync>
  >;
  return { ...loaded, cfg: resolveAgentTestConfig(loaded.cfg) };
}

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) =>
    loadAgentSessionFixture(params.key, {
      agentId: params.agentId,
      projection: params.projection,
      clone: false,
    }),
}));

vi.mock("../../config/sessions/session-transcript-anchor-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../config/sessions/session-transcript-anchor-read.js")
    >();
  return {
    ...actual,
    readSessionTranscriptAnchorsAsync: (
      ...args: Parameters<typeof actual.readSessionTranscriptAnchorsAsync>
    ) =>
      args[1].includeMetadata
        ? Promise.resolve({
            anchors: [],
            metadata: {
              present: mocks.hasSessionTranscriptEventsSync(args[0]),
              ...mocks.readTranscriptMutationStateSync(args[0]),
            },
          })
        : actual.readSessionTranscriptAnchorsAsync(...args),
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveSessionLifecycleTimestamps: mocks.resolveSessionLifecycleTimestamps,
    resolveAgentIdFromSessionKey: (sessionKey: string, configuredDefaultAgentId?: string) => {
      const m = /^agent:([^:]+):/.exec(sessionKey.trim());
      return m?.[1] ?? configuredDefaultAgentId ?? "main";
    },
    resolveExplicitAgentSessionKey: mocks.resolveExplicitAgentSessionKey,
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  };
});

// mock-isolation: Handler fixtures supply lifecycle timestamps without opening transcript readers.
vi.mock("../../config/sessions/lifecycle-read.js", () => ({
  hasTerminalMainSessionTranscriptNewerThanRegistryAsync: async () => false,
  resolveSessionLifecycleTimestampsAsync: async (
    params: Parameters<typeof mocks.resolveSessionLifecycleTimestamps>[0],
  ) => mocks.resolveSessionLifecycleTimestamps(params),
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  // The accessor barrel is still initializing when this mock resolves (import cycle through the
  // session controller), so take exact-read helpers from their defining module.
  const exactRead = await import("../../config/sessions/session-accessor.sqlite-exact-read.js");
  const admittedRead =
    await import("../../config/sessions/session-accessor.sqlite-entry-admitted-read.js");
  const listRead = await import("../../config/sessions/session-accessor.sqlite-entry-list.read.js");
  return {
    ...actual,
    loadExactSessionEntryCandidates: admittedRead.loadExactSessionEntryCandidates,
    loadExactSessionEntryReadOnly: exactRead.loadExactSessionEntryReadOnly,
    listSessionEntriesReadOnly: listRead.listSessionEntriesReadOnly,
    applySessionEntryReplacements: mocks.applySessionEntryReplacements,
    patchSessionEntryTarget: mocks.patchSessionEntryTarget,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    // These handler fixtures own an in-memory store; participant access must not reach shared /tmp SQLite.
    recordSessionParticipant: mocks.recordSessionParticipant,
    listSessionParticipantsReadOnly: mocks.listSessionParticipantsReadOnly,
  };
});

// mock-isolation: Handler routing uses an in-memory store; atomic reset durability has real owner tests.
vi.mock("../../config/sessions/session-accessor.lifecycle.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/sessions/session-accessor.lifecycle.js")>(
    "../../config/sessions/session-accessor.lifecycle.js",
  )),
  resetSessionEntryLifecycle: mocks.resetSessionEntryLifecycle,
}));

vi.mock("../../config/sessions/session-accessor.pending-inputs.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/session-accessor.pending-inputs.js")
  >("../../config/sessions/session-accessor.pending-inputs.js");
  return { ...actual, stageSessionPendingInput: mocks.stageSessionPendingInput };
});

vi.mock("../../sessions/user-turn-transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../sessions/user-turn-transcript.js")>(
    "../../sessions/user-turn-transcript.js",
  );
  return {
    ...actual,
    createUserTurnTranscriptRecorder: (
      params: Parameters<typeof actual.createUserTurnTranscriptRecorder>[0],
    ) =>
      createAgentTestUserTurnRecorder(
        actual.createUserTurnTranscriptRecorder,
        params,
        mocks.userTurnStorePath,
      ),
  };
});

vi.mock("../../commands/agent.js", () => {
  const agentCommand = (...args: Parameters<typeof mocks.agentCommand>) => {
    const result = mocks.agentCommand(...args);
    for (const listener of mocks.agentCommandListeners) {
      listener();
    }
    return result;
  };
  return {
    agentCommand,
    agentCommandFromGatewayIngress: agentCommand,
    agentCommandFromIngress: agentCommand,
  };
});

vi.mock("../../agents/prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/prepared-model-runtime.js")>();
  // Direct handler tests bypass Gateway startup, so provide the lifecycle fact
  // that production publishes before admitting agent RPCs.
  const pluginRegistry = createEmptyPluginRegistry();
  const pluginGeneration: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry,
    inboundPluginRegistry: pluginRegistry,
    configuredCatalogEntries: [],
    inlineProviderModels: [],
  };
  const createLease = (input: PreparedModelRuntimeInput): PreparedModelRuntimeLease => {
    let open = true;
    const agentId = input.agentId ?? "main";
    const workspaceDir = input.workspaceDir ?? "/tmp/workspace";
    return {
      snapshot: {
        ...input,
        agentId,
        workspaceDir,
        observationConfig: input.config,
        catalogOwner: { agentId, workspaceDir },
        metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry,
        activeProjectKeys: [],
        allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
        authModes: {},
        modelCatalog: { entries: [], routeVariants: [] },
        configuredRuntimeModels: [],
        findConfiguredRuntimeModel: () => undefined,
        inlineProviderModels: [],
        isCurrent: () => open,
        createStores: () => {
          throw new Error("Direct handler fixture does not execute model stores");
        },
      },
      pluginGeneration,
      run<T>(run: () => T): T {
        if (!open) {
          throw new Error("Prepared model runtime lease is closed");
        }
        return run();
      },
      [Symbol.asyncDispose]: vi.fn(async () => {
        open = false;
      }),
    };
  };
  return {
    ...actual,
    acquireAgentRunPreparedModelRuntime: vi.fn(async (input: PreparedModelRuntimeInput) =>
      createLease(input),
    ),
    loadPublishedGatewayReplyDispatchRuntime: async ({
      agentId,
      onRuntimeLease,
    }: {
      agentId: string;
      onRuntimeLease?: (lease: PreparedModelRuntimeLease) => void;
    }) => {
      const runtime = {
        agentId,
        agentDir: "/tmp/agent",
        config: resolveAgentTestConfig(),
        pluginGeneration,
        workspaceDir: "/tmp/workspace",
        modelCatalog: { entries: [], routeVariants: [] },
        inboundPluginRegistry: pluginRegistry,
      };
      onRuntimeLease?.(createLease({ ...runtime, allowGatewaySubagentBinding: true }));
      return runtime;
    },
  };
});

vi.mock("../../acp/runtime/session-meta.js", async () => {
  const actual = await vi.importActual<typeof import("../../acp/runtime/session-meta.js")>(
    "../../acp/runtime/session-meta.js",
  );
  return {
    ...actual,
    readAcpSessionMetaAsync: mocks.readAcpSessionMetaAsync,
    readAcpSessionEntryAsync: async (
      params: Parameters<typeof actual.readAcpSessionEntryAsync>[0],
    ): ReturnType<typeof actual.readAcpSessionEntryAsync> => {
      params.assertCurrent?.();
      const loaded = loadAgentSessionFixture(params.sessionKey, {
        agentId: params.agentId,
        clone: params.clone,
      });
      const acp = await mocks.readAcpSessionMetaAsync(params);
      params.assertCurrent?.();
      return {
        cfg: loaded.cfg,
        agentId: loaded.agentId ?? params.agentId,
        storePath: loaded.storePath,
        sessionKey: params.sessionKey,
        storeSessionKey: loaded.canonicalKey,
        entry: loaded.entry,
        acp,
      };
    },
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => resolveAgentTestConfig(),
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: mocks.listAgentIds,
    resolveSessionAgentId: ({
      sessionKey,
      agentId,
    }: {
      sessionKey?: string | null;
      agentId?: string;
      config?: Record<string, unknown>;
    }) => {
      const m = /^agent:([^:]+):/.exec((sessionKey ?? "").trim());
      return agentId ?? m?.[1] ?? "main";
    },
    resolveSessionAgentIds: ({
      sessionKey,
      agentId,
      fallbackAgentId,
    }: {
      sessionKey?: string | null;
      agentId?: string;
      fallbackAgentId?: string;
    }) => {
      const parsedAgentId = /^agent:([^:]+):/.exec((sessionKey ?? "").trim())?.[1];
      return {
        defaultAgentId: "main",
        sessionAgentId: agentId ?? parsedAgentId ?? fallbackAgentId ?? "main",
      };
    },
    resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
    resolveAgentWorkspaceDir: (cfg: OpenClawConfig, agentId?: string) =>
      (agentId ? cfg.agents?.entries?.[agentId]?.workspace : undefined) ??
      cfg?.agents?.defaults?.workspace ??
      "/tmp/workspace",
    resolveNativeModelPrimary: () => undefined,
  };
});

vi.mock("../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-events.js")>();
  return {
    ...actual,
    assertAgentRunLifecycleGenerationCurrent: (lifecycleGeneration: string) => {
      if (lifecycleGeneration === mocks.lifecycleGeneration) {
        return;
      }
      const error = new Error("Agent run belongs to a stale gateway lifecycle");
      error.name = "AbortError";
      throw error;
    },
    emitAgentEvent: mocks.emitAgentEvent,
    getAgentEventLifecycleGeneration: () => mocks.lifecycleGeneration,
    isAgentEventLifecycleGenerationCurrent: (generation: string) =>
      generation === mocks.lifecycleGeneration,
    registerAgentEventLifecycleRotationHandler: vi.fn(),
  };
});

vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  claimAgentRunContext: mocks.registerAgentRunContext,
  clearAgentRunContext: mocks.clearAgentRunContext,
  getAgentRunContext: vi.fn(() => undefined),
  getAgentRunLifecycleGeneration: () => mocks.lifecycleGeneration,
  resolveProjectedAgentRunProgressState: vi.fn(() => undefined),
  registerAgentRunContext: mocks.registerAgentRunContext,
}));

// Completed-follow-up fixtures may supply the matching live owner. Other cases
// retain real paused-run adoption and descendant reads over their seeded rows.
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../agents/subagents/registry/subagent-registry-read.js")
    >();
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: mocks.getLatestSubagentRunByChildSessionKey,
    getLatestLiveSubagentRunByChildSessionKey: (
      ...args: Parameters<typeof actual.getLatestLiveSubagentRunByChildSessionKey>
    ) => {
      if (!mocks.getLatestLiveSubagentRunByChildSessionKey.getMockImplementation()) {
        return actual.getLatestLiveSubagentRunByChildSessionKey(...args);
      }
      const run = mocks.getLatestLiveSubagentRunByChildSessionKey(...args);
      return run && run.childSessionKey === args[0].trim() && (!args[1] || args[1](run))
        ? run
        : null;
    },
  };
});

vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry.js")
  >()),
  replaceSubagentRunAfterSteerCore: mocks.replaceSubagentRunAfterSteer,
}));

vi.mock("../session-lifecycle-plugin-hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-lifecycle-plugin-hooks.js")>()),
  emitGatewaySessionEndPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionEndPluginHook as (...args: unknown[]) => unknown)(...args),
  emitGatewaySessionStartPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionStartPluginHook as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../session-reset-service.js", () => ({
  emitGatewaySessionEndPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionEndPluginHook as (...args: unknown[]) => unknown)(...args),
  emitGatewaySessionStartPluginHook: (...args: unknown[]) =>
    (mocks.emitGatewaySessionStartPluginHook as (...args: unknown[]) => unknown)(...args),
  performGatewaySessionReset: (...args: unknown[]) =>
    (mocks.performGatewaySessionReset as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../infra/voicewake-routing.js", () => ({
  loadVoiceWakeRoutingConfig: mocks.loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger: mocks.resolveVoiceWakeRouteByTrigger,
}));

vi.mock("../../infra/outbound/agent-delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/outbound/agent-delivery.js")>(
    "../../infra/outbound/agent-delivery.js",
  );
  return {
    ...actual,
    resolveAgentExplicitRecipientSession: mocks.resolveAgentExplicitRecipientSession,
  };
});

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) =>
    (mocks.resolveSendPolicy as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: Parameters<typeof actual.getChannelPlugin>) => {
      const override = mocks.getChannelPlugin.getMockImplementation();
      return override
        ? (override(...args) as ReturnType<typeof actual.getChannelPlugin>)
        : actual.getChannelPlugin(...args);
    },
  };
});

vi.mock("../../channels/message/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/message/runtime.js")>(
    "../../channels/message/runtime.js",
  );
  return {
    ...actual,
    sendDurableMessageBatchCore: (
      ...args: Parameters<typeof actual.sendDurableMessageBatchCore>
    ) => {
      const override = mocks.sendDurableMessageBatch.getMockImplementation();
      return override
        ? (mocks.sendDurableMessageBatch(...args) as ReturnType<
            typeof actual.sendDurableMessageBatchCore
          >)
        : actual.sendDurableMessageBatchCore(...args);
    },
  };
});

export const resetSessionAccessorMocks = createSessionAccessorMockReset(mocks);

resetSessionAccessorMocks();

export { mocks };
