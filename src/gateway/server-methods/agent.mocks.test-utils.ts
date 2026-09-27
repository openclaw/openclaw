// Register fixture mocks before importing the Gateway handlers that consume them.
// oxfmt-ignore
import { subagentRegistryMocks } from "./agent.subagent-registry.mocks.test-support.js";
import { vi } from "vitest";
import type { readAcpSessionMetaAsync } from "../../acp/runtime/session-meta.js";
import type { SessionEntry } from "../../config/sessions.js";
import type {
  hasSessionTranscriptEventsSync,
  readTranscriptMutationStateSync,
  recordSessionParticipant,
  listSessionParticipantsReadOnly,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTestUserTurnRecorder } from "./agent.user-turn-recorder.test-support.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  applySessionEntryReplacements: vi.fn(),
  patchSessionEntryTarget: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
  stageSessionPendingInput: vi.fn<typeof stageSessionPendingInput>(),
  recordSessionParticipant: vi.fn<typeof recordSessionParticipant>(async () => "inserted"),
  listSessionParticipantsReadOnly: vi.fn<typeof listSessionParticipantsReadOnly>(() => new Map()),
  hasSessionTranscriptEventsSync: vi.fn<typeof hasSessionTranscriptEventsSync>(() => false),
  readTranscriptMutationStateSync: vi.fn<typeof readTranscriptMutationStateSync>(() => ({
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
  if (cfg.agents?.list) {
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
      list: agentIds.map((id) => ({ id })),
    },
  };
  if (cfg === mocks.loadConfigReturn) {
    mocks.loadConfigReturn = resolved;
  }
  return resolved;
}

function loadAgentSessionFixture(
  ...args: Parameters<typeof import("../session-utils.js").loadSessionEntry>
): ReturnType<typeof import("../session-utils.js").loadSessionEntry> {
  const loaded = mocks.loadSessionEntry(...args) as ReturnType<
    typeof import("../session-utils.js").loadSessionEntry
  >;
  return { ...loaded, cfg: resolveAgentTestConfig(loaded.cfg) };
}

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: loadAgentSessionFixture,
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
    resolveAgentIdFromSessionKey: (sessionKey: string) => {
      const m = /^agent:([^:]+):/.exec(sessionKey.trim());
      return m?.[1] ?? "main";
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

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    applySessionEntryReplacements: mocks.applySessionEntryReplacements,
    patchSessionEntryTarget: mocks.patchSessionEntryTarget,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    stageSessionPendingInput: mocks.stageSessionPendingInput,
    // These handler fixtures own an in-memory store; participant access must not reach shared /tmp SQLite.
    recordSessionParticipant: mocks.recordSessionParticipant,
    listSessionParticipantsReadOnly: mocks.listSessionParticipantsReadOnly,
    hasSessionTranscriptEventsSync: mocks.hasSessionTranscriptEventsSync,
    readTranscriptMutationStateSync: mocks.readTranscriptMutationStateSync,
  };
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

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  // Direct handler tests bypass Gateway startup, so provide the lifecycle fact
  // that production publishes before admitting agent RPCs.
  acquireAgentRunPreparedModelRuntime: vi.fn(async () => ({
    [Symbol.asyncDispose]: vi.fn(async () => {}),
    snapshot: {},
  })),
  loadPublishedGatewayReplyDispatchRuntime: async ({ agentId }: { agentId: string }) => ({
    agentId,
    agentDir: "/tmp/agent",
    config: resolveAgentTestConfig(),
    pluginGeneration: { pluginMetadataSnapshot: {} },
    workspaceDir: "/tmp/workspace",
  }),
}));

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
    resolveDefaultAgentId: (cfg?: {
      agents?: { list?: Array<{ id?: string; default?: boolean }> };
    }) =>
      cfg?.agents?.list?.find((agent) => agent.default)?.id ?? cfg?.agents?.list?.[0]?.id ?? "main",
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
    resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
      cfg.agents?.list?.find((agent) => agent.id === agentId),
    resolveAgentWorkspaceDir: (
      cfg: {
        agents?: {
          defaults?: { workspace?: string };
          list?: Array<{ id?: string; workspace?: string }>;
        };
      },
      agentId?: string,
    ) =>
      cfg?.agents?.list?.find((agent) => agent.id === agentId)?.workspace ??
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

// Only the lookup this harness asserts on is stubbed; the rest of the read
// surface stays real so registry paths reached through the gateway (paused-run
// adoption, descendant queries) observe the runs these tests seed.
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestSubagentRunByChildSessionKey: mocks.getLatestSubagentRunByChildSessionKey,
}));

vi.mock("../../agents/subagents/registry/subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: mocks.replaceSubagentRunAfterSteer,
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

type SessionStoreFixture = Record<string, Record<string, unknown>>;

type SessionEntryTargetFixture = {
  canonicalKey: string;
  storeKeys: string[];
};

function cloneSessionStoreFixtureEntry(
  entry: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return entry ? structuredClone(entry) : undefined;
}

function selectFreshestTargetFixtureEntry(
  store: SessionStoreFixture,
  target: SessionEntryTargetFixture,
): { entry: Record<string, unknown>; key: string } | undefined {
  let freshest: { entry: Record<string, unknown>; key: string } | undefined;
  for (const key of new Set([target.canonicalKey, ...target.storeKeys])) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (
      !freshest ||
      ((entry.updatedAt as number | undefined) ?? 0) >
        ((freshest.entry.updatedAt as number | undefined) ?? 0)
    ) {
      freshest = { entry, key };
    }
  }
  return freshest;
}

export function resetSessionAccessorMocks() {
  // These handler fixtures own an in-memory store. Real admission durability
  // and execution-time promotion are covered by the gateway-server suites.
  mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
    options.assertCurrent();
    const message = options.prepareMessageAfterIdempotencyCheck
      ? options.prepareMessageAfterIdempotencyCheck(options.message)
      : options.message;
    return message
      ? {
          state: "queued",
          inputId: "test-user-turn",
          message,
          run: (operation) => operation(),
          finish: vi.fn(),
        }
      : undefined;
  });
  mocks.recordSessionParticipant.mockReset().mockResolvedValue("inserted");
  mocks.listSessionParticipantsReadOnly.mockReset().mockReturnValue(new Map());
  mocks.hasSessionTranscriptEventsSync.mockReset().mockReturnValue(false);
  mocks.readTranscriptMutationStateSync.mockReset().mockReturnValue({
    observedAt: null,
    updatedAt: null,
  });
  mocks.applySessionEntryReplacements.mockReset().mockImplementation(
    async (params: {
      activeSessionKey?: string;
      requireWriteSuccess?: boolean;
      sessionKeys?: readonly string[];
      skipMaintenance?: boolean;
      storePath: string;
      update: (entries: Array<{ sessionKey: string; entry: SessionEntry }>) =>
        | Promise<{
            replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
            result: unknown;
          }>
        | {
            replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
            result: unknown;
          };
    }) => {
      let updateResult: Promise<unknown> | undefined;
      await mocks.updateSessionStore(
        params.storePath,
        (store: Record<string, SessionEntry>) => {
          updateResult = (async () => {
            const keys = params.sessionKeys ?? Object.keys(store);
            const snapshots = keys.flatMap((sessionKey) => {
              const entry = store[sessionKey];
              return entry ? [{ sessionKey, entry: structuredClone(entry) }] : [];
            });
            const planned = await params.update(snapshots);
            for (const replacement of planned.replacements ?? []) {
              if (store[replacement.sessionKey]) {
                store[replacement.sessionKey] = structuredClone(replacement.entry);
              }
            }
            return planned.result;
          })();
          return updateResult;
        },
        {
          activeSessionKey: params.activeSessionKey,
          requireWriteSuccess: params.requireWriteSuccess,
          skipMaintenance: params.skipMaintenance,
        },
      );
      // Empty store stubs must still run the projection; undefined can be its valid result.
      return updateResult === undefined ? (await params.update([])).result : await updateResult;
    },
  );
  mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(
    async (
      scope: {
        agentId?: string;
        sessionId: string;
        sessionKey: string;
        sessionEntry?: SessionEntry;
        storePath?: string;
      },
      options: {
        messages: Array<{
          message: unknown;
          prepareMessageAfterIdempotencyCheck?: (message: unknown) => unknown;
        }>;
      },
    ) => {
      const candidate = options.messages[0]?.message;
      const message =
        options.messages[0]?.prepareMessageAfterIdempotencyCheck?.(candidate) ?? candidate;
      if (!message) {
        return { appendedCount: 0, messages: [], sessionEntry: scope.sessionEntry };
      }
      return {
        appendedCount: 1,
        messages: [
          {
            appended: true,
            messageId: "test-user-turn",
            message,
            anchor: {
              agentId: scope.agentId ?? "main",
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              storePath: scope.storePath ?? "/tmp/sessions.json",
              generation: "test-generation",
              entryId: "test-user-turn",
              rawSeq: 1,
              effectiveParentId: null,
              activeMessagePosition: 0,
            },
          },
        ],
        sessionEntry: scope.sessionEntry,
      };
    },
  );
  mocks.patchSessionEntryTarget.mockReset().mockImplementation(
    async (
      scope: { storePath: string; target: SessionEntryTargetFixture },
      update: (
        entry: Record<string, unknown>,
        context: { existingEntry?: Record<string, unknown> },
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
      options: {
        fallbackEntry?: Record<string, unknown>;
        replaceEntry?: boolean;
      } = {},
    ) =>
      await mocks.updateSessionStore(
        scope.storePath,
        async (store: SessionStoreFixture) => {
          const existing = selectFreshestTargetFixtureEntry(store, scope.target);
          const base = existing?.entry ?? options.fallbackEntry;
          if (!base) {
            return null;
          }
          const patchContext = existing ? { existingEntry: structuredClone(existing.entry) } : {};
          const patch = await update(structuredClone(base), patchContext);
          if (!patch) {
            return cloneSessionStoreFixtureEntry(base);
          }
          const fresh = selectFreshestTargetFixtureEntry(store, scope.target);
          const writeBase = fresh?.entry ?? options.fallbackEntry;
          if (!writeBase) {
            return null;
          }
          const next = options.replaceEntry ? structuredClone(patch) : { ...writeBase, ...patch };
          for (const key of new Set([scope.target.canonicalKey, ...scope.target.storeKeys])) {
            delete store[key];
          }
          store[scope.target.canonicalKey] = next;
          return next;
        },
        options,
      ),
  );
}

resetSessionAccessorMocks();

export { mocks };
