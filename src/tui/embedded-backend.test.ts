import fs from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveThinkingDefault } from "../agents/model-thinking-default.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  clearEmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  clearEmbeddedQuestionBroker,
  getEmbeddedQuestionBroker,
} from "../infra/embedded-question-broker.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { notifyListeners } from "../shared/listeners.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerEmbeddedFollowupTests } from "./embedded-backend.followup.test-support.js";
import { registerEmbeddedHistoryProjectionTests } from "./embedded-backend.history.test-support.js";
import type { EmbeddedTuiBackend as EmbeddedTuiBackendType } from "./embedded-backend.js";
import { registerEmbeddedBackendShutdownTests } from "./embedded-backend.shutdown.test-support.js";
import {
  agentResult,
  assistantMessage,
  captureBackendEvents,
  getChatPayloads,
  expectAgentCall,
  mainChatEvent,
  mockLocalSession,
  pendingReply,
  registerEmbeddedBackendStreamTests,
  type EmbeddedAgentResult,
} from "./embedded-backend.stream.test-support.js";
import {
  deferred,
  flushMicrotasks,
  localSessionEntry,
  sendMainChat,
} from "./embedded-backend.test-helpers.js";
import {
  registerEmbeddedModelCatalogTests,
  withEmbeddedModelCatalogOwnerFixture,
} from "./embedded-model-catalog.test-support.js";
import {
  createPreparedProjectionMethods,
  registerEmbeddedSessionReaderTests,
} from "./embedded-session-reader.test-support.js";
import type { TuiModelChoice } from "./tui-backend.js";

let EmbeddedTuiBackend: typeof EmbeddedTuiBackendType;
let backend: EmbeddedTuiBackendType;
let events: ReturnType<typeof captureBackendEvents>;

const runAgent = vi.fn();
const steer = vi.fn();
const claimAnswer = vi.fn();
const getOperation = vi.fn();
const runSideQuestion = vi.fn();
const usageCost = vi.fn();
const updateSessionStoreMock = vi.fn();
const applyPatch = vi.fn();
const projectPatch = vi.fn();
const patchResult = vi.fn();
const readAcpSessionMetaForEntriesMock =
  vi.fn<typeof import("../acp/runtime/session-meta-readonly.js").readAcpSessionMetaForEntries>();
const createSessionGoalMock = vi.fn();
const clearSessionGoalMock = vi.fn();
const getSessionGoalMock = vi.fn();
const updateSessionGoalObjectiveMock = vi.fn();
const updateSessionGoalStatusMock = vi.fn();
const loadPlugins = vi.fn();
const ensureContextWindowCacheLoadedMock = vi.fn(async () => undefined);
const migrateSessions = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const publishRuntime = vi.fn<(_config: unknown, _options?: unknown) => Promise<void>>(
  async () => undefined,
);
const unregisterConfigWriteListenerMock = vi.fn();
let configWriteListener: ((event: { runtimeConfig: Record<string, unknown> }) => void) | undefined;
const createGatewaySessionMock = vi.fn();
const listProjectedSessionsMock = vi.fn(
  async (_options?: unknown): Promise<{ sessions: unknown[] }> => ({ sessions: [] }),
);
const preparedProjectionMethods = createPreparedProjectionMethods(() => sessionProjection);
const sessionProjection = {
  ...preparedProjectionMethods,
  dispose: vi.fn(),
  ensureMaterialized: vi.fn(async () => {}),
  describe:
    vi.fn<
      (target: {
        key: string;
      }) => { entry: Record<string, unknown>; target: { key: string } } | undefined
    >(),
  snapshot: vi.fn<(_target: { key: string }) => { row: { key: string; sessionId: unknown } }>(),
};
const createProjection = vi.fn(async (_options?: unknown) => sessionProjection);
const buildGatewaySessionRowMock = vi.fn(
  (params: { key: string; entry?: { sessionId?: string; thinkingLevel?: string } }) => ({
    key: params.key,
    kind: "direct",
    updatedAt: null,
    sessionId: params.entry?.sessionId,
    thinkingLevel: params.entry?.thinkingLevel,
  }),
);
const getSessionDefaultsMock = vi.fn(() => ({
  modelProvider: null,
  model: null,
  contextTokens: null,
}));
const getConfig = vi.fn(() => ({}));
const loadCatalog = vi.fn((_params?: LoadPreparedModelCatalogParams): ModelCatalogEntry[] => []);
const resolveThinkingDefaultMock = vi.fn<typeof resolveThinkingDefault>();
const listModels = vi.fn(
  async (
    _params: Parameters<
      typeof import("../gateway/server-methods/models-list-result.js").buildModelsListResult
    >[0],
  ): Promise<{ models: TuiModelChoice[] }> => ({ models: [] }),
);
const withCatalog = vi.fn(withEmbeddedModelCatalogOwnerFixture);
const readHistory = vi.fn(
  async (
    _params?: unknown,
  ): Promise<import("../config/sessions/session-history-types.js").ChatHistoryPage> => ({
    messages: [],
  }),
);
const loadSession = vi.fn(localSessionEntry);
let registeredListener: ((evt: unknown) => void) | undefined;
const embeddedEventTimestamp = Date.parse("2026-05-09T07:26:00.000Z");

vi.mock("../agents/agent-command.js", () => ({
  agentCommandFromIngress: (...args: unknown[]) => runAgent(...args),
}));

// mock-isolation: Question-answer receipts are scripted independently of the process-wide native run registry.
vi.mock("../agents/embedded-agent-runner/runs.js", () => ({
  claimPendingEmbeddedAgentQuestionAnswer: (...args: unknown[]) => claimAnswer(...args),
}));

// mock-isolation: The backend uses sentinel operations and scripted steering receipts, not live controller injection.
vi.mock("../sessions/session-controller.steer.js", () => ({
  steerSessionControllerOperation: (...args: unknown[]) => steer(...args),
}));

vi.mock("../sessions/session-controller.state.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSessionControllerOperation: (...args: unknown[]) => getOperation(...args),
}));

vi.mock("../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: unknown[]) => runSideQuestion(...args),
}));

vi.mock("../auto-reply/reply/commands-session-cost.runtime.js", () => ({
  formatSessionUsageCostSummary: (...args: unknown[]) => usageCost(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: (listener: (evt: unknown) => void) => {
    registeredListener = listener;
    return () => {
      if (registeredListener === listener) {
        registeredListener = undefined;
      }
    };
  },
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/sessions.js", () => ({
  clearSessionGoal: (...args: unknown[]) => clearSessionGoalMock(...args),
  createSessionGoal: (...args: unknown[]) => createSessionGoalMock(...args),
  formatSessionGoalStatus: (goal?: { objective?: string }) =>
    goal ? `Goal: ${goal.objective ?? ""}` : "No goal for this session.",
  getSessionGoal: (...args: unknown[]) => getSessionGoalMock(...args),
  resolveAgentMainSessionKey: () => "agent:main:main",
  resolveSessionStorePathCore: () => "/tmp/openclaw-sessions.json",
  updateSessionGoalObjective: (...args: unknown[]) => updateSessionGoalObjectiveMock(...args),
  updateSessionGoalStatus: (...args: unknown[]) => updateSessionGoalStatusMock(...args),
  updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionPatchProjection: (...args: unknown[]) => applyPatch(...args),
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}`,
  resolveSessionAgentId: (params: { sessionKey?: string; agentId?: string }) =>
    params.agentId ?? /^agent:([^:]+):/.exec(params.sessionKey ?? "")?.[1] ?? "main",
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: (...args: unknown[]) => loadPlugins(...args),
}));

vi.mock("../agents/context.js", () => ({
  ensureContextWindowCacheLoaded: () => ensureContextWindowCacheLoadedMock(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: (...args: Parameters<typeof publishRuntime>) =>
    publishRuntime(...args),
}));

vi.mock("../agents/defaults.js", () => ({ DEFAULT_PROVIDER: "openai" }));

vi.mock("../agents/model-selection.js", () => ({
  resolveThinkingDefault: (...args: Parameters<typeof resolveThinkingDefault>) =>
    resolveThinkingDefaultMock(...args),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  readPreparedModelCatalog: (params?: LoadPreparedModelCatalogParams) => loadCatalog(params),
  loadPreparedModelCatalogSnapshot: async (params?: LoadPreparedModelCatalogParams) => {
    const entries = loadCatalog(params);
    return { entries, routeVariants: entries };
  },
  withPreparedModelCatalogOwner: (...args: Parameters<typeof withCatalog>) => withCatalog(...args),
}));

vi.mock("../gateway/server-methods/models-list-result.js", () => ({
  buildModelsListResult: (...args: Parameters<typeof listModels>) => listModels(...args),
}));

// mock-isolation: Embedded-backend fixtures own config publication and listeners without loading operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => getConfig(),
  captureRuntimeConfigAsyncReader: () => async () => getConfig(),
  loadConfig: () => getConfig(),
  registerConfigWriteListener: (
    listener: (event: { runtimeConfig: Record<string, unknown> }) => void,
  ) => {
    configWriteListener = listener;
    return unregisterConfigWriteListenerMock;
  },
}));

vi.mock("../config/sessions/startup-migration.js", () => ({
  runSessionStartupMigration: (...args: Parameters<typeof migrateSessions>) =>
    migrateSessions(...args),
}));

vi.mock("../gateway/session-row-projection.js", () => ({
  createSessionRowProjection: (...args: Parameters<typeof createProjection>) =>
    createProjection(...args),
}));

vi.mock("../gateway/session-utils-row.js", () => ({
  buildGatewaySessionRow: (params: Parameters<typeof buildGatewaySessionRowMock>[0]) =>
    buildGatewaySessionRowMock(params),
}));

// mock-isolation: The embedded fixture has no stored parent sessions; never query a real lineage database.
vi.mock("../gateway/session-utils-store-lineage.js", () => ({
  prepareGatewaySessionEntryReader: async () => () => undefined,
}));

vi.mock("../gateway/session-utils-list.js", () => ({
  listProjectedSessions: (...args: unknown[]) => listProjectedSessionsMock(...args),
}));

vi.mock("../agents/tools/embedded-gateway-stub.runtime.js", () => ({
  listProjectedSessions: (...args: unknown[]) => listProjectedSessionsMock(...args),
}));

vi.mock("../gateway/chat-display-projection.js", () => ({
  projectChatDisplayMessages: (messages: unknown[]) => messages,
  resolveEffectiveChatHistoryMaxChars: () => 100_000,
}));

vi.mock("../gateway/server-constants.js", () => ({
  getMaxChatHistoryMessagesBytes: () => 100_000,
}));

vi.mock("../gateway/server-methods/chat-history-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/server-methods/chat-history-budget.js")>()),
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  replaceOversizedChatHistoryMessages: ({ messages }: { messages: unknown[] }) => ({ messages }),
}));

// mock-isolation: The embedded backend fixture bypasses Gateway history presentation.
vi.mock("../gateway/server-methods/chat-history-response-page.js", () => ({
  enrichChatHistoryCompactionMarkers: (messages: unknown[]) => messages,
}));

vi.mock("../gateway/server-methods/chat-history-pages.js", () => ({
  readChatHistoryPage: (params: unknown) => readHistory(params),
}));

// mock-isolation: Use the synthetic session fixture without opening Gateway worker databases.
vi.mock("../gateway/session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: ({
    key,
    cfg: _cfg,
    ...opts
  }: {
    key: string;
    cfg: unknown;
    agentId?: string;
    includeStoreChildEntries?: boolean;
  }) => Promise.resolve(loadSession(key, Object.keys(opts).length ? opts : undefined)),
  resolveGatewaySessionStoreTargetInWorker: async ({
    key,
    agentId,
  }: {
    key: string;
    agentId?: string;
  }) => ({
    agentId: agentId ?? parseAgentSessionKey(key)?.agentId ?? "main",
    canonicalKey: key,
    storeKeys: [key],
    storePath: "/tmp/openclaw-sessions.json",
  }),
}));

// mock-isolation: Embedded-backend tests supply defaults and model facts without loading Gateway storage.
vi.mock("../gateway/session-utils.js", () => ({
  getSessionDefaults: () => getSessionDefaultsMock(),
  listAgentsForGateway: () => [],
  resolveCanonicalGatewaySessionStoreKey: ({ key }: { key: string }) => ({
    primaryKey: key,
    target: { storeKeys: [key] },
  }),
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
}));

vi.mock("../gateway/session-utils-model.js", () => ({
  projectSessionPatchResult: (...args: unknown[]) => patchResult(...args),
}));

vi.mock("../acp/runtime/session-meta-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/runtime/session-meta-readonly.js")>()),
  readAcpSessionMetaForEntries: (...args: Parameters<typeof readAcpSessionMetaForEntriesMock>) =>
    readAcpSessionMetaForEntriesMock(...args),
}));

vi.mock("../gateway/session-create-service.js", () => ({
  createGatewaySession: (...args: unknown[]) => createGatewaySessionMock(...args),
}));

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: () => ({
    ok: true,
    key: "agent:main:main",
    entry: {},
    resolved: { modelProvider: "openai", model: "gpt-5.4" },
  }),
}));

vi.mock("../gateway/session-transcript-readers.js", () => ({
  capArrayByJsonBytes: (items: unknown[]) => ({ items }),
}));

vi.mock("../gateway/sessions-patch.js", () => ({
  projectSessionsPatchEntry: (...args: unknown[]) => projectPatch(...args),
}));

vi.mock("../gateway/server-methods/agent-timestamp.js", () => ({
  injectTimestamp: (message: string) => message,
  timestampOptsFromConfig: () => ({}),
}));

function emitRegisteredAgentEvent(evt: unknown) {
  if (registeredListener) {
    notifyListeners([registeredListener], evt);
  }
}

function emitRunEvent(runId: string, stream: string, data: unknown) {
  registeredListener?.({ runId, stream, data });
}

function send(message: string, runId: string) {
  return sendMainChat(backend, message, runId);
}

function abortMain(runId?: string) {
  return backend.abortChat({ sessionKey: "agent:main:main", ...(runId ? { runId } : {}) });
}

async function withStartedBackend(run: () => Promise<void>) {
  backend.start();
  try {
    await run();
  } finally {
    await backend.stop();
  }
}

function storedSession(overrides: Partial<ReturnType<typeof localSessionEntry>> = {}) {
  return {
    cfg: {},
    agentId: "main",
    canonicalKey: "agent:main:main",
    storePath: "/tmp/openclaw-sessions.json",
    ...overrides,
  };
}

function globalSession(agentId: string, entry: Record<string, unknown>) {
  return {
    cfg: { session: { scope: "global" } },
    agentId,
    canonicalKey: "global",
    storePath: `/tmp/openclaw-${agentId}-sessions.json`,
    entry,
  };
}

function sendGlobalChat(agentId: string, message: string, runId: string) {
  return backend.sendChat({ sessionKey: "global", agentId, message, runId });
}

type PatchStore = Readonly<Record<string, Record<string, unknown>>>;
function projectFromStore(readStore: () => PatchStore = () => ({})) {
  return async (params: {
    project: (context: {
      primaryKey: string;
      store: PatchStore;
      existingEntry?: Record<string, unknown>;
      isLabelInUse: (label: string) => boolean;
    }) => Promise<unknown>;
    resolveTarget: (snapshot: { store: PatchStore }) => { primaryKey: string };
  }) => {
    const store = readStore();
    const target = params.resolveTarget({ store });
    const existingEntry = store[target.primaryKey];
    return await params.project({
      ...target,
      store,
      ...(existingEntry ? { existingEntry } : {}),
      isLabelInUse: () => false,
    });
  };
}

function abortableReply(abortText?: string) {
  const pending = deferred<EmbeddedAgentResult>();
  const onAbort = vi.fn(
    abortText === undefined ? undefined : () => pending.resolve(agentResult(abortText)),
  );
  runAgent.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
    opts.abortSignal?.addEventListener("abort", onAbort);
    return pending.promise;
  });
  return { pending, onAbort };
}

async function startPendingChat(message: string, runId: string) {
  const pending = pendingReply(runAgent);
  backend.start();
  await send(message, runId);
  return pending;
}

const selectedGlobalSessionCases = [
  { input: { sessionKey: "global", agentId: "work" }, owner: "work" },
  { input: { sessionKey: "agent:research:main" }, owner: "research" },
];

describe("EmbeddedTuiBackend", () => {
  const originalRuntimeLog = defaultRuntime.log;
  const originalRuntimeError = defaultRuntime.error;

  beforeAll(async () => {
    ({ EmbeddedTuiBackend } = await import("./embedded-backend.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(embeddedEventTimestamp);
    runAgent.mockReset();
    steer.mockReset();
    claimAnswer.mockReset().mockResolvedValue(null);
    getOperation.mockReset().mockReturnValue(undefined);
    runSideQuestion.mockReset();
    usageCost.mockReset().mockResolvedValue("💸 Usage cost\nSession $1.23");
    updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (_storePath: string, update: (store: Record<string, unknown>) => unknown) =>
          await update({}),
      );
    createSessionGoalMock
      .mockReset()
      .mockImplementation(async ({ objective }: { objective: string }) => ({
        objective,
        tokensUsed: 0,
      }));
    clearSessionGoalMock.mockReset().mockResolvedValue(false);
    getSessionGoalMock.mockReset().mockResolvedValue({ status: "missing" });
    updateSessionGoalObjectiveMock.mockReset();
    updateSessionGoalStatusMock
      .mockReset()
      .mockImplementation(async ({ status }: { status: string }) => ({
        objective: "ship",
        status,
        tokensUsed: 0,
      }));
    loadPlugins.mockReset();
    ensureContextWindowCacheLoadedMock.mockReset().mockResolvedValue(undefined);
    migrateSessions.mockReset().mockResolvedValue(undefined);
    publishRuntime.mockReset().mockResolvedValue(undefined);
    unregisterConfigWriteListenerMock.mockReset();
    configWriteListener = undefined;
    createGatewaySessionMock.mockReset().mockResolvedValue({
      ok: true,
      key: "agent:main:tui-created",
      entry: { sessionId: "created-session" },
      resolved: { modelProvider: "openai", model: "gpt-5.4" },
      resetExisting: false,
    });
    listProjectedSessionsMock.mockReset().mockResolvedValue({ sessions: [] });
    sessionProjection.dispose.mockReset();
    sessionProjection.ensureMaterialized.mockClear();
    sessionProjection.describe.mockReset();
    sessionProjection.describe.mockImplementation((target) => {
      const entry = loadSession.mock.results.at(-1)?.value?.entry;
      return entry ? { entry, target } : undefined;
    });
    sessionProjection.present.mockClear();
    sessionProjection.withPreparedExactRows.mockClear();
    sessionProjection.snapshot.mockReset();
    sessionProjection.snapshot.mockImplementation(({ key }) => ({
      row: { key, sessionId: loadSession.mock.results.at(-1)?.value?.entry?.sessionId },
    }));
    createProjection.mockReset().mockResolvedValue(sessionProjection);
    applyPatch.mockReset().mockImplementation(projectFromStore());
    projectPatch.mockReset().mockResolvedValue({ ok: true, entry: {} });
    patchResult.mockReset();
    readAcpSessionMetaForEntriesMock
      .mockReset()
      .mockImplementation(async ({ entries }) => entries.map(() => null));
    patchResult.mockImplementation(
      (params: { canonicalKey: string; entry: unknown; storePath: string }) => ({
        ok: true,
        path: params.storePath,
        key: params.canonicalKey,
        entry: params.entry,
        resolved: { modelProvider: "openai", model: "gpt-5.4" },
      }),
    );
    getConfig.mockReset().mockReturnValue({});
    loadCatalog.mockReset().mockReturnValue([]);
    listModels.mockReset().mockResolvedValue({ models: [] });
    withCatalog.mockClear();
    resolveThinkingDefaultMock.mockReset();
    readHistory.mockReset().mockResolvedValue({ messages: [] });
    loadSession.mockReset().mockImplementation(localSessionEntry);
    buildGatewaySessionRowMock.mockClear();
    getSessionDefaultsMock.mockClear();
    registeredListener = undefined;
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
    backend = new EmbeddedTuiBackend();
    events = captureBackendEvents(backend);
  });

  afterEach(() => {
    const broker = getEmbeddedPluginApprovalBroker();
    broker?.stop();
    if (broker) {
      clearEmbeddedPluginApprovalBroker(broker);
    }
    const questionBroker = getEmbeddedQuestionBroker();
    questionBroker?.stop();
    if (questionBroker) {
      clearEmbeddedQuestionBroker(questionBroker);
    }
    vi.useRealTimers();
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  it("returns the resolved model from the shared reset lifecycle", async () => {
    await expect(backend.resetSession("main", "new")).resolves.toEqual({
      ok: true,
      key: "agent:main:main",
      entry: {},
      resolved: { modelProvider: "openai", model: "gpt-5.4" },
    });
  });

  it.each([
    { key: "agent:work:new", parentSessionKey: "agent:work:main" },
    { key: "global", agentId: "work" },
  ])("creates $key using its resolved owner's raw prepared catalog", async (input) => {
    const config = { agents: { ownership: "explicit", entries: { main: {}, work: {} } } };
    getConfig.mockReturnValue(config);
    const catalog: ModelCatalogEntry[] = [
      { id: "work-model", name: "Work", provider: "fixture", api: "openai-completions" },
    ];
    loadCatalog.mockReturnValue(catalog);
    createGatewaySessionMock.mockImplementation(
      async ({
        loadGatewayModelCatalogSnapshot,
      }: {
        loadGatewayModelCatalogSnapshot: () => Promise<{
          entries: unknown[];
          routeVariants: unknown[];
        }>;
      }) => {
        expect(await loadGatewayModelCatalogSnapshot()).toEqual({
          entries: catalog,
          routeVariants: catalog,
        });
        return {
          ok: true,
          key: input.key,
          entry: { sessionId: "new-session" },
          resolved: {},
          resetExisting: false,
        };
      },
    );

    await expect(backend.createSession(input)).resolves.toEqual({
      ok: true,
      key: input.key,
      entry: { sessionId: "new-session" },
      resolved: {},
    });
    expect(createGatewaySessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        cfg: config,
        armSessionDiffBaselineCapture: true,
        emitCommandHooks: Boolean(input.parentSessionKey),
        commandSource: "tui:embedded",
        loadGatewayModelCatalogSnapshot: expect.any(Function),
      }),
    );
    expect(loadCatalog).toHaveBeenCalledWith({ config, agentId: "work", readOnly: true });
    expect(listModels).not.toHaveBeenCalled();
  });

  it("bridges assistant and lifecycle events into chat events", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    const onConnected = vi.fn();
    backend.onConnected = onConnected;
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await flushMicrotasks();
    expect(onConnected).toHaveBeenCalledTimes(1);

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "hello",
      runId: "run-local-1",
      timeoutMs: 300_000,
    });
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngressMock.mock.calls[0]?.[0].timeout).toBe("300");

    registeredListener?.({
      runId: "run-local-1",
      stream: "assistant",
      data: { delta: "hello" },
    });
    registeredListener?.({
      runId: "run-local-1",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "hello" }], meta: {} });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "assistant",
          data: { delta: "hello" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "delta",
          deltaText: "hello",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "final",
          stopReason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
    ]);
  });

  it("isolates TUI event consumer failures in the agent event bus", async () => {
    const pending = pendingReply(runAgent);
    backend.onEvent = () => {
      throw new Error("render failed");
    };
    backend.start();
    await send("hello", "run-listener-error");

    expect(() =>
      emitRegisteredAgentEvent({
        runId: "run-listener-error",
        stream: "assistant",
        data: { text: "hello", delta: "hello" },
      }),
    ).not.toThrow();
    await flushMicrotasks();

    backend.onEvent = undefined;
    pending.resolve(agentResult("hello"));
    await flushMicrotasks();
    await backend.stop();
  });

  it("bridges question events and answers through the registered local broker", async () => {
    await withStartedBackend(async () => {
      const broker = getEmbeddedQuestionBroker();
      if (!broker) {
        throw new Error("expected embedded question broker");
      }
      const { id } = broker.request({
        sessionKey: "agent:main:main",
        agentId: "main",
        questions: [
          { questionId: "target", header: "Target", question: "Which target?", options: [] },
        ],
      });
      const { questions } = await backend.listQuestions();
      expect(questions).toHaveLength(1);
      expect(events).toContainEqual({ event: "question.requested", payload: questions[0] });
      const waiting = broker.waitAnswer({ id, includeResolutionId: true });
      const answers = { answers: { target: ["Staging"] } };
      await expect(
        backend.resolveQuestion({ id, answers, resolutionId: "local-answer" }),
      ).resolves.toEqual({ status: "answered", answers });
      await expect(waiting).resolves.toEqual({
        status: "answered",
        answers,
        resolutionId: "local-answer",
      });
      await expect(backend.getQuestion(id)).resolves.toMatchObject({
        question: { id, status: "answered", answers },
      });
      expect(events).toContainEqual({
        event: "question.resolved",
        payload: { id, status: "answered", answers },
      });
    });
    expect(getEmbeddedQuestionBroker()).toBeNull();
  });

  it("bridges local plugin approvals without a Gateway", async () => {
    backend.start();
    await flushMicrotasks();

    const approvalBroker = getEmbeddedPluginApprovalBroker();
    if (!approvalBroker) {
      throw new Error("expected embedded plugin approval broker");
    }
    const decision = approvalBroker.request({
      request: {
        title: "Apply workspace skill proposal",
        description: "Apply a pending workspace skill proposal into live workspace skills.",
        toolName: "skill_workshop",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny"],
      },
      timeoutMs: 5_000,
    });
    const approvals = await backend.listPluginApprovals();
    const approval = Array.isArray(approvals) ? approvals[0] : undefined;

    expect(approval).toMatchObject({
      request: {
        title: "Apply workspace skill proposal",
        toolName: "skill_workshop",
        sessionKey: "agent:main:main",
      },
    });
    expect(events).toContainEqual({ event: "plugin.approval.requested", payload: approval });
    await expect(backend.resolvePluginApproval(approval?.id, "allow-once")).resolves.toEqual({
      ok: true,
    });
    await expect(decision).resolves.toMatchObject({ decision: "allow-once" });

    await backend.stop();
    expect(getEmbeddedPluginApprovalBroker()).toBeNull();
  });

  registerEmbeddedModelCatalogTests({
    createBackend: () => new EmbeddedTuiBackend(),
    getRuntimeConfigMock: getConfig,
    loadPreparedModelCatalogMock: loadCatalog,
    buildModelsListResultMock: listModels,
    withPreparedModelCatalogOwnerMock: withCatalog,
    projectSessionsPatchEntryMock: projectPatch,
    applySessionPatchProjectionMock: applyPatch,
    deferred,
    flushMicrotasks,
  });

  it("rejects a missing harness-owned session before a local patch can create it", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-patch";
    projectPatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "INVALID_REQUEST", message: AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE },
    });

    await expect(backend.patchSession({ key: sessionKey, label: "squat" })).rejects.toThrow(
      AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
    );

    expect(applyPatch).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionKeys: expect.anything() }),
    );
    expect(projectPatch).toHaveBeenCalledWith(
      expect.objectContaining({ storeKey: sessionKey, existingEntry: undefined }),
    );
  });

  it("allows local patches to an existing harness-owned session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing-patch";
    const existingEntry = {
      sessionId: "existing-harness-session",
      updatedAt: embeddedEventTimestamp,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    applyPatch.mockImplementationOnce(projectFromStore(() => ({ [sessionKey]: existingEntry })));
    projectPatch.mockResolvedValueOnce({
      ok: true,
      entry: { ...existingEntry, label: "kept" },
    });

    await expect(backend.patchSession({ key: sessionKey, label: "kept" })).resolves.toMatchObject({
      ok: true,
      key: sessionKey,
      entry: { sessionId: "existing-harness-session", label: "kept" },
    });
    expect(projectPatch).toHaveBeenCalledWith(
      expect.objectContaining({ storeKey: sessionKey, existingEntry }),
    );
  });

  registerEmbeddedSessionReaderTests({
    createBackend: () => new EmbeddedTuiBackend(),
    sessionProjection,
    createSessionRowProjectionMock: createProjection,
    listProjectedSessionsMock,
    runSessionStartupMigrationMock: migrateSessions,
    getRuntimeConfigMock: getConfig,
    refreshPreparedModelRuntimeSnapshotsMock: publishRuntime,
    agentCommandFromIngressMock: runAgent,
    unregisterConfigWriteListenerMock,
    flushMicrotasks,
  });

  registerEmbeddedHistoryProjectionTests({
    createBackend: () => new EmbeddedTuiBackend(),
    loadSessionEntry: loadSession,
    describe: sessionProjection.describe,
    present: sessionProjection.present,
    withPreparedExactRows: sessionProjection.withPreparedExactRows,
    buildSessionRow: buildGatewaySessionRowMock,
  });

  it("rejects embedded session reads when the actual startup migration finds a legacy store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = await state.writeText(
        "custom/sessions.json",
        JSON.stringify({ "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 } }),
      );
      const before = await fs.readFile(storePath);
      getConfig.mockReturnValue({ session: { store: storePath } });
      const actual = await vi.importActual<
        typeof import("../config/sessions/startup-migration.js")
      >("../config/sessions/startup-migration.js");
      migrateSessions.mockImplementationOnce(async (...args: unknown[]) => {
        await actual.runSessionStartupMigration(
          args[0] as Parameters<typeof actual.runSessionStartupMigration>[0],
        );
      });

      await withStartedBackend(async () => {
        await expect(backend.listSessions({ agentId: "main" })).rejects.toThrow(
          "Legacy session store requires migration",
        );
      });
      expect(await fs.readFile(storePath)).toEqual(before);
    });
  });

  it("queues config runtime publication ahead of later local turns and unregisters on stop", async () => {
    const initialConfig = { agents: { entries: { main: {} } } };
    const nextConfig = { agents: { entries: { main: {} }, defaults: { model: "openai/next" } } };
    getConfig.mockReturnValue(initialConfig);
    backend.start();
    await vi.waitFor(() => expect(publishRuntime).toHaveBeenCalledOnce());

    const replacement = deferred<void>();
    publishRuntime.mockReturnValueOnce(replacement.promise);
    configWriteListener?.({ runtimeConfig: nextConfig });

    const sending = send("after config write", "run-waits-for-config-runtime");
    await flushMicrotasks();

    expect(publishRuntime).toHaveBeenLastCalledWith(nextConfig);
    expect(runAgent).not.toHaveBeenCalled();

    replacement.resolve();
    await sending;
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    await backend.stop();

    expect(unregisterConfigWriteListenerMock).toHaveBeenCalledOnce();
  });

  it("forwards overlapping config publications immediately for runtime latest-wins coalescing", async () => {
    const initialConfig = { agents: { entries: { main: {} } } };
    const middleConfig = { agents: { defaults: { model: "openai/middle" } } };
    const latestConfig = { agents: { defaults: { model: "openai/latest" } } };
    getConfig.mockReturnValue(initialConfig);
    const initial = deferred<void>();
    const middle = deferred<void>();
    const latest = deferred<void>();
    publishRuntime
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(middle.promise)
      .mockReturnValueOnce(latest.promise);
    backend.start();
    await vi.waitFor(() => expect(publishRuntime).toHaveBeenCalledOnce());

    try {
      configWriteListener?.({ runtimeConfig: middleConfig });
      configWriteListener?.({ runtimeConfig: latestConfig });
      await flushMicrotasks();

      expect(publishRuntime).toHaveBeenNthCalledWith(2, middleConfig);
      expect(publishRuntime).toHaveBeenNthCalledWith(3, latestConfig);
    } finally {
      initial.resolve();
      middle.resolve();
      latest.resolve();
      await backend.stop();
    }
  });

  it("rechecks runtime publication when a queued turn reaches model admission", async () => {
    const first = deferred<EmbeddedAgentResult>();
    runAgent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(agentResult("second done"));
    mockLocalSession(loadSession, () => ({
      cfg: { messages: { queue: { mode: "followup" } } },
      entry: { queueDebounceMs: 0 },
    }));
    backend.start();
    await send("first", "runtime-refresh-first");
    await send("queued second", "runtime-refresh-second");

    const replacement = deferred<void>();
    publishRuntime.mockReturnValueOnce(replacement.promise);
    configWriteListener?.({
      runtimeConfig: { agents: { defaults: { model: "openai/next" } } },
    });
    first.resolve(agentResult("first done"));
    await flushMicrotasks();

    expect(runAgent).toHaveBeenCalledTimes(1);

    replacement.resolve();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await backend.stop();
  });

  it("creates a local session entry before starting a goal", async () => {
    loadSession.mockReturnValueOnce(storedSession({}));

    await expect(
      backend.runGoalCommand({
        sessionKey: "agent:main:main",
        command: "/GOAL start Ship Goal",
      }),
    ).resolves.toEqual({ text: "Goal started: Ship Goal", continuationPrompt: "Ship Goal" });
    expect(createSessionGoalMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      storePath: "/tmp/openclaw-sessions.json",
      objective: "Ship Goal",
      actor: { type: "human" },
      fallbackEntry: { sessionId: expect.any(String), updatedAt: expect.any(Number) },
    });
  });

  it("uses the selected agent when running local global goal commands", async () => {
    loadSession.mockReturnValueOnce(
      storedSession({
        agentId: "work",
        canonicalKey: "global",
        storePath: "/tmp/openclaw-work-sessions.json",
        entry: { sessionId: "session-work", updatedAt: embeddedEventTimestamp },
      }),
    );

    await expect(
      backend.runGoalCommand({
        sessionKey: "global",
        agentId: "work",
        command: "/goal status",
      }),
    ).resolves.toEqual({ text: "No goal for this session." });

    expect(loadSession).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(getSessionGoalMock).toHaveBeenCalledWith({
      sessionKey: "global",
      storePath: "/tmp/openclaw-work-sessions.json",
    });
  });

  it.each(selectedGlobalSessionCases)(
    "runs local usage cost with the stored owner: $input.sessionKey",
    async ({ input, owner }) => {
      const cfg = { session: { scope: "global" } };
      const sessionEntry = { sessionId: `session-${owner}`, updatedAt: embeddedEventTimestamp };
      loadSession.mockReturnValueOnce(
        storedSession({
          cfg,
          agentId: owner,
          canonicalKey: "global",
          storePath: `/tmp/openclaw-${owner}-sessions.json`,
          entry: sessionEntry,
        }),
      );

      await expect(backend.runUsageCostCommand(input)).resolves.toEqual({
        text: "💸 Usage cost\nSession $1.23",
      });

      expect(loadSession).toHaveBeenCalledWith(
        input.sessionKey,
        input.agentId ? { agentId: input.agentId } : undefined,
      );
      expect(usageCost).toHaveBeenCalledWith({
        cfg,
        sessionKey: "global",
        agentId: owner,
        sessionEntry,
        storePath: `/tmp/openclaw-${owner}-sessions.json`,
      });
      expect(runAgent).not.toHaveBeenCalled();
    },
  );

  it.each(selectedGlobalSessionCases)(
    "records local goal mutations with the stored owner: $input.sessionKey",
    async ({ input, owner }) => {
      const entry = { sessionId: `session-${owner}`, updatedAt: embeddedEventTimestamp };
      const storePath = `/tmp/openclaw-${owner}-sessions.json`;
      loadSession.mockReturnValueOnce(
        storedSession({
          cfg: { session: { scope: "global" } },
          agentId: owner,
          canonicalKey: "global",
          storePath,
          entry,
        }),
      );
      await expect(
        backend.runGoalCommand({ ...input, command: "/goal start Ship Goal" }),
      ).resolves.toMatchObject({ text: "Goal started: Ship Goal" });
      expect(createSessionGoalMock).toHaveBeenCalledWith({
        sessionKey: "global",
        storePath,
        agentId: owner,
        actor: { type: "human" },
        objective: "Ship Goal",
        fallbackEntry: entry,
      });
    },
  );

  it("loads history thinking defaults from the selected owner's model config and prepared catalog", async () => {
    const catalog: ModelCatalogEntry[] = [
      { id: "gpt-5.4", name: "Reasoning model", provider: "openai", reasoning: true },
    ];
    loadCatalog.mockReturnValue(catalog);
    resolveThinkingDefaultMock.mockImplementationOnce(resolveThinkingDefault);
    loadSession.mockReturnValue({
      cfg: {
        agents: {
          defaults: { models: { "openai/gpt-5.4": { params: { thinking: "high" } } } },
          entries: {
            work: { models: { "openai/gpt-5.4": { params: { thinking: "low" } } } },
          },
        },
        models: {
          mode: "replace",
          providers: { "tui-pty-mock": { models: [{ id: "gpt-5.5" }] } },
        },
      },
      agentId: "work",
      canonicalKey: "agent:work:main",
      entry: {},
    });
    await withStartedBackend(async () => {
      await expect(backend.loadHistory({ sessionKey: "agent:work:main" })).resolves.toMatchObject({
        sessionKey: "agent:work:main",
        messages: [],
        thinkingLevel: "low",
        sessionInfo: { thinkingLevel: "low" },
      });
    });
    expect(loadCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", readOnly: true }),
    );
    expect(resolveThinkingDefaultMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-5.4", catalog }),
    );
  });

  it.each(selectedGlobalSessionCases)(
    "loads selected-agent global history from the selected agent store: $input.sessionKey",
    async ({ input, owner }) => {
      const entry = { sessionId: `session-${owner}-global` };
      loadSession.mockReturnValue(globalSession(owner, entry));
      await withStartedBackend(async () => {
        await expect(backend.loadHistory(input)).resolves.toMatchObject({
          sessionKey: input.sessionKey,
          sessionId: entry.sessionId,
          sessionInfo: { key: "global", sessionId: entry.sessionId },
          messages: [],
        });
      });
      expect(loadSession).toHaveBeenCalledWith(input.sessionKey, {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        includeStoreChildEntries: true,
      });
      expect(readHistory).toHaveBeenCalledWith(
        expect.objectContaining({ canonicalKey: "global", sessionAgentId: owner, entry }),
      );
      expect(sessionProjection.present).toHaveBeenCalled();
      expect(buildGatewaySessionRowMock).not.toHaveBeenCalled();
    },
  );

  it("preserves incognito history metadata without adding the row to the resident projection", async () => {
    const entry = { sessionId: "private-session", incognito: true };
    const key = "agent:main:dashboard:private";
    loadSession.mockReturnValue(
      storedSession({
        canonicalKey: key,
        storePath: "/tmp/private.sqlite",
        store: { [key]: entry },
        entry,
      }),
    );
    await withStartedBackend(async () => {
      await expect(backend.loadHistory({ sessionKey: key })).resolves.toMatchObject({
        sessionId: entry.sessionId,
        sessionInfo: { key, sessionId: entry.sessionId },
      });
      expect(buildGatewaySessionRowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key,
          entry,
          storePath: "/tmp/private.sqlite",
          lightweightListRow: true,
        }),
      );
      expect(sessionProjection.present).not.toHaveBeenCalled();
    });
  });

  it.each([{ input: { sessionKey: "global" }, owner: "main" }, ...selectedGlobalSessionCases])(
    "keeps the selected owner and gateway subagent binding off for embedded /btw: $input.sessionKey ($owner)",
    async ({ input, owner }) => {
      // The embedded TUI runs the side question locally, so it must not borrow the
      // active registry's subagent and node capabilities. Only gateway-hosted
      // callers opt into allowGatewaySubagentBinding.
      loadSession.mockReturnValue(
        storedSession({
          cfg: { session: { scope: "global" } },
          agentId: owner,
          canonicalKey: "global",
          storePath: `/tmp/openclaw-${owner}-sessions.json`,
          store: {},
          entry: { sessionId: `session-${owner}-global` },
        }),
      );
      runSideQuestion.mockResolvedValueOnce({ text: "side done" });
      await withStartedBackend(async () => {
        await backend.sendChat({
          ...input,
          message: "/btw local only",
          runId: "run-btw-local",
        });
        await vi.waitFor(() => expect(runSideQuestion).toHaveBeenCalledTimes(1));
        expect(runSideQuestion).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "global",
            agentId: owner,
            agentDir: `/tmp/openclaw-agent-${owner}/agent`,
          }),
        );
        expect(runSideQuestion.mock.calls[0]?.[0]).not.toHaveProperty(
          "allowGatewaySubagentBinding",
        );
      });
    },
  );

  it("reports the newest matching non-BTW local run in embedded history", async () => {
    mockLocalSession(loadSession, () => ({
      storePath: "/tmp/openclaw-work-sessions.json",
      entry: { sessionId: "session-work-global" },
    }));
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    const side = deferred<{ text: string }>();
    runAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    runSideQuestion.mockReturnValueOnce(side.promise);
    backend.start();
    await sendGlobalChat("work", "first", "run-work-first");
    await sendGlobalChat("work", "second", "run-work-newest");
    await sendGlobalChat("work", "/btw detached", "run-work-btw");

    await expect(
      backend.loadHistory({ sessionKey: "global", agentId: "work" }),
    ).resolves.toMatchObject({ inFlightRun: { runId: "run-work-newest", text: "" } });

    side.resolve({ text: "side done" });
    first.resolve(agentResult("first done"));
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    second.resolve(agentResult("second done"));
    await flushMicrotasks();
    await backend.stop();
  });

  it("uses the canonical gateway projector for embedded TUI history reads", async () => {
    loadSession.mockReturnValue(storedSession({ entry: { sessionId: "sess-main" } }));
    const messages = [
      {
        role: "toolResult",
        toolCallId: "wait",
        toolName: "collab.wait",
        content: "raw result",
        isError: false,
        __openclaw: { id: "wait-result" },
      },
    ];
    readHistory.mockResolvedValueOnce({
      messages,
      activity: [{ messageId: "wait-result", items: [] }],
    });
    const history = await backend.loadHistory({ sessionKey: "agent:main:main" });
    expect(history).toMatchObject({
      messages,
      activity: [{ messageId: "wait-result", items: [] }],
    });

    expect(readHistory).toHaveBeenCalledWith({
      entry: { sessionId: "sess-main" },
      provider: "openai",
      sessionId: "sess-main",
      storePath: "/tmp/openclaw-sessions.json",
      sessionAgentId: "main",
      canonicalKey: "agent:main:main",
      max: 200,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 100_000,
      offset: undefined,
      messageId: undefined,
    });
  });

  it.each([false, true])("loads history despite runtime plugin failure=%s", async (fails) => {
    if (fails) {
      loadPlugins.mockImplementationOnce(() => {
        throw new Error("runtime unavailable");
      });
    }
    const cfg = { agents: { entries: { main: {} } } };
    loadSession.mockReturnValue(
      storedSession({ cfg, entry: { spawnedWorkspaceDir: "/tmp/openclaw-custom-workspace" } }),
    );

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      messages: [],
      runtimePluginsPrewarm: fails
        ? { status: "failed", error: "runtime unavailable" }
        : { status: "warmed" },
    });
    expect(loadPlugins).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: "/tmp/openclaw-agent-main",
    });
  });

  it("waits for the newest publication before returning model choices", async () => {
    const initial = deferred<void>();
    const replacement = deferred<void>();
    publishRuntime.mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise);
    backend.start();
    const choices = backend.listModels({ agentId: "work" });
    await flushMicrotasks();
    expect(withCatalog).not.toHaveBeenCalled();

    configWriteListener?.({ runtimeConfig: {} });
    initial.resolve();
    await flushMicrotasks();
    expect(withCatalog).not.toHaveBeenCalled();

    listModels.mockResolvedValue({
      models: [{ provider: "fixture", id: "updated", name: "Updated" }],
    });
    replacement.resolve();
    await expect(choices).resolves.toMatchObject([{ id: "updated" }]);
    await backend.stop();
  });

  it("reports publication failure instead of returning stale model choices", async () => {
    const publishing = deferred<void>();
    const publication = deferred<void>();
    publishRuntime.mockImplementationOnce(() => {
      publishing.resolve();
      return publication.promise;
    });
    backend.start();
    const choices = backend.listModels({ agentId: "work" });
    const failure = expect(choices).rejects.toThrow("catalog publication failed");

    await publishing.promise;
    publication.reject(new Error("catalog publication failed"));
    await failure;
    expect(withCatalog).not.toHaveBeenCalled();
    await expect(backend.stop()).rejects.toThrow("catalog publication failed");
  });

  it.each(selectedGlobalSessionCases)(
    "passes selected-agent global scope into local chat turns: $input.sessionKey",
    async ({ input, owner }) => {
      const entry = { sessionId: `session-${owner}-global` };
      loadSession.mockReturnValue(globalSession(owner, entry));
      runAgent.mockResolvedValueOnce(agentResult("done"));
      await withStartedBackend(async () => {
        await backend.sendChat({ ...input, message: "hello", runId: "run-global-owner" });
        await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

        expect(loadSession).toHaveBeenCalledWith(
          input.sessionKey,
          input.agentId ? { agentId: input.agentId } : undefined,
        );
        expect(runAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "global",
            agentId: owner,
            sessionId: entry.sessionId,
            message: expect.stringContaining("hello"),
          }),
          expect.anything(),
          expect.anything(),
        );
      });
    },
  );

  it("stamps the selected global agent on chat, agent, and BTW envelopes", async () => {
    mockLocalSession(loadSession, () => ({
      storePath: "/tmp/openclaw-work-sessions.json",
      entry: { sessionId: "session-work-global" },
    }));
    const pending = pendingReply(runAgent);
    runSideQuestion.mockResolvedValueOnce({ text: "side done" });
    backend.onEvent = (event) => events.push({ event: event.event, payload: event.payload });
    backend.start();

    await sendGlobalChat("work", "hello", "run-global-work");
    emitRunEvent("run-global-work", "assistant", { delta: "hello" });
    pending.resolve(agentResult("hello"));
    await flushMicrotasks();
    await sendGlobalChat("work", "/btw detached", "run-global-work-btw");
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        event: "chat.side_result",
        payload: expect.objectContaining({ text: "side done", agentId: "work" }),
      }),
    );
    expect(runSideQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        senderId: runAgent.mock.calls[0]?.[0]?.runContext?.senderId,
      }),
    );

    expect(
      events.filter((event) => ["chat", "agent", "chat.side_result"].includes(event.event)),
    ).not.toHaveLength(0);
    for (const event of events) {
      if (!["chat", "agent", "chat.side_result"].includes(event.event)) {
        continue;
      }
      expect(event.payload).toMatchObject({ sessionKey: "global", agentId: "work" });
    }
    await backend.stop();
  });

  registerEmbeddedBackendShutdownTests({
    createBackend: () => new EmbeddedTuiBackend(),
    agentCommandFromIngressMock: runAgent,
    getRegisteredListener: () => registeredListener,
    originalRuntimeLog,
    originalRuntimeError,
  });

  it.each(["active", "finishing", "end", "steering rejected", "persisted followup"])(
    "queues same-session sends behind a run with %s",
    async (phase) => {
      await withEnvAsync(
        phase === "active" ? { OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" } : {},
        async () => {
          const { pending: first, onAbort: firstAbortListener } = abortableReply();
          const second = pendingReply(runAgent);
          if (phase === "steering rejected" || phase === "persisted followup") {
            getOperation.mockReturnValue({ sessionId: "active-session" });
          }
          if (phase === "steering rejected") {
            steer.mockResolvedValue({ status: "rejected", reason: "runtime_rejected" });
          }
          if (phase === "persisted followup") {
            mockLocalSession(loadSession, () => ({
              cfg: { messages: { queue: { mode: "steer" } } },
              entry: { queueMode: "followup", queueDebounceMs: 0 },
            }));
          }
          backend.start();
          await send("first", "run-local-first");
          if (phase === "active" || phase === "finishing") {
            emitRunEvent("run-local-first", "assistant", {
              text: "first done",
              delta: "first done",
            });
          }
          if (phase === "finishing" || phase === "end") {
            emitRunEvent("run-local-first", "lifecycle", { phase, stopReason: "stop" });
          }
          await send("second", "run-local-second");
          if (phase === "active") {
            await vi.advanceTimersByTimeAsync(5);
            await flushMicrotasks();
          }
          expect(firstAbortListener).not.toHaveBeenCalled();
          expect(runAgent).toHaveBeenCalledTimes(1);
          if (phase === "persisted followup") {
            expect(steer).not.toHaveBeenCalled();
          }
          first.resolve(agentResult("first done"));
          await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
          second.resolve(agentResult("second done"));
          await flushMicrotasks();
        },
      );
    },
  );

  const followupTestContext = {
    createBackend: () => new EmbeddedTuiBackend(),
    agentCommandFromIngressMock: runAgent,
    loadSessionEntryMock: loadSession,
    getSessionControllerOperationMock: getOperation,
    steerSessionControllerOperationMock: steer,
    claimPendingEmbeddedAgentQuestionAnswerMock: claimAnswer,
    updateSessionStoreMock,
    emitAgentEvent: (event: unknown) => registeredListener?.(event),
  };
  registerEmbeddedFollowupTests(followupTestContext);

  it("keeps later queued turns behind the active provider when intermediate turns are canceled", async () => {
    const active = deferred<EmbeddedAgentResult>();
    let activeSignal: AbortSignal | undefined;
    runAgent
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        activeSignal = opts.abortSignal;
        return active.promise;
      })
      .mockResolvedValueOnce(agentResult("the later turn completed"));
    mockLocalSession(loadSession, () => ({
      cfg: { messages: { queue: { mode: "followup" } } },
      entry: { queueDebounceMs: 0 },
    }));
    backend.start();

    await send("first", "queue-first");
    await send("second", "queue-second");
    await send("third", "queue-third");
    await send("fourth", "queue-fourth");
    await abortMain("queue-second");
    await flushMicrotasks();

    expect(events).toContainEqual(mainChatEvent("queue-second", { state: "aborted" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(activeSignal?.aborted).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(1);

    await abortMain("queue-third");
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toContainEqual(mainChatEvent("queue-third", { state: "aborted" }));
    expect(activeSignal?.aborted).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(1);

    active.resolve(agentResult("the active turn completed"));
    await expectAgentCall(runAgent, 2, { runId: "queue-fourth", message: "fourth" });
  });

  it("claims local question input before applying interrupt queue policy", async () => {
    const mode = "interrupt";
    const first = pendingReply(runAgent);
    getOperation.mockReturnValue({ sessionId: "active-session" });
    loadSession.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode } } },
      agentId: "main",
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));
    backend.start();
    try {
      await send("ask a question", "question-owner");
      claimAnswer.mockResolvedValue({ runId: "question-owner" });
      await expect(send("Green", "answer-send")).resolves.toEqual({
        runId: "question-owner",
      });
      expect(claimAnswer).toHaveBeenCalledWith({ sessionId: "active-session" }, "Green");
      expect(steer).not.toHaveBeenCalled();
      first.resolve(agentResult("answered"));
      await flushMicrotasks();
      expect(runAgent).toHaveBeenCalledTimes(1);
    } finally {
      first.resolve(agentResult(undefined));
      await backend.stop();
    }
  });

  it("steers only the selected physical store when active owners share their key and session ID", async () => {
    const { getSessionControllerOperation } = await vi.importActual<
      typeof import("../sessions/session-controller.state.js")
    >("../sessions/session-controller.state.js");
    const { steerSessionControllerOperation } = await vi.importActual<
      typeof import("../sessions/session-controller.steer.js")
    >("../sessions/session-controller.steer.js");
    const { createReplyOperation } = await import("../sessions/session-controller.operation.js");
    const { captureSessionTarget } = await import("../sessions/session-controller.target.js");
    const { prepareReplyToolAuthority } =
      await import("../auto-reply/reply/reply-tool-authority.js");
    const { withMessageInjectionAdmission } =
      await import("../auto-reply/reply/message-injection-authority.js");
    const { INTERNAL_MESSAGE_CHANNEL } = await import("../utils/message-channel-constants.js");
    getOperation.mockImplementation(getSessionControllerOperation);
    steer.mockImplementation(steerSessionControllerOperation);
    const first = pendingReply(runAgent);
    const sessionKey = "agent:main:main";
    const sessionId = "shared-session-id";
    const stores = ["/tmp/tui-owner-a/sessions.json", "/tmp/tui-owner-b/sessions.json"];
    const accepted: string[][] = [[], []];
    const operations = stores.map((storeScope) =>
      createReplyOperation({
        sessionKey,
        sessionId,
        agentId: "main",
        turnKind: "direct",
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope,
          sessionKey,
          agentId: "main",
          incarnation: sessionId,
        }),
      }),
    );
    try {
      mockLocalSession(loadSession, () => ({
        storePath: stores[1],
        cfg: { messages: { queue: { mode: "steer", debounceMs: 0 } } },
        entry: { sessionId, updatedAt: 0, permissionMode: "full" },
      }));
      backend.start();
      await send("first", "selected-local-run");
      const senderId = runAgent.mock.calls[0]?.[0]?.runContext?.senderId;
      expect(senderId).toEqual(expect.any(String));
      for (const [index, operation] of operations.entries()) {
        await operation.bindToolAuthoritySnapshotAsync(
          prepareReplyToolAuthority({
            originatingChannel: INTERNAL_MESSAGE_CHANNEL,
            disableTools: false,
            run: {
              sessionId,
              sessionFile: `/tmp/tui-owner-${index}/session.jsonl`,
              workspaceDir: "/tmp",
              provider: "openai",
              model: "gpt-test",
              config: {},
              messageProvider: INTERNAL_MESSAGE_CHANNEL,
              senderId,
              permissionMode: "full",
              senderIsOwner: false,
              traceAuthorized: false,
            },
          }),
        );
        await operation.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" });
        operation.attachBackend({
          kind: "embedded",
          runId: `physical-owner-${index}`,
          cancel: () => {},
          supportsTranscriptCommitWait: true,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async () => {
              throw new Error("Prepared steering is required");
            },
            queueMessageAsync: async (text, _options, preparation) => {
              await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
                preparation.assertCurrent();
                accepted[index]!.push(text);
              });
            },
          },
        });
        operation.setPhase("running");
      }
      await expect(send("use the selected store", "steer-send")).resolves.toEqual({
        runId: "selected-local-run",
      });
      expect(accepted).toEqual([[], ["use the selected store"]]);
      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      first.resolve(agentResult(undefined));
      await backend.stop();
      for (const operation of operations) {
        operation.complete();
      }
    }
  });

  it.each(["claim", "steer", "steer receipt failure", "steer unconfirmed result"])(
    "surfaces uncertain question input from %s without queuing it again",
    async (route) => {
      const first = pendingReply(runAgent);
      getOperation.mockReturnValue({ sessionId: "active-session" });
      const error = new QuestionAnswerUnconfirmedError("synthetic-question");
      if (route === "claim") {
        claimAnswer.mockRejectedValue(error);
      } else if (route === "steer receipt failure") {
        steer.mockRejectedValue(error);
      } else if (route === "steer unconfirmed result") {
        steer.mockResolvedValue({
          status: "accepted",
          result: { transcriptCommit: "unconfirmed", errorMessage: error.message },
        });
      } else {
        // The controller reports an unconfirmed answer as consumed, never replayable.
        steer.mockResolvedValue({ status: "indeterminate", errorMessage: error.message });
      }
      backend.start();
      await send("first", "run-local-first");
      try {
        await expect(send("answer", "run-local-second")).rejects.toThrow(error.message);
      } finally {
        first.resolve(agentResult("done"));
        await flushMicrotasks();
      }
      expect(runAgent).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a local overflow summary after future drops switch to old", async () => {
    const nextDropPolicy = "old";
    const active = deferred<EmbeddedAgentResult>();
    const collected = deferred<EmbeddedAgentResult>();
    runAgent.mockReturnValueOnce(active.promise).mockReturnValueOnce(collected.promise);
    let dropPolicy: "summarize" | "old" | "new" = "summarize";
    let cap = 1;
    mockLocalSession(loadSession, () => ({
      cfg: { messages: { queue: { mode: "collect", cap, drop: dropPolicy } } },
      entry: { queueDebounceMs: 0 },
    }));
    await withStartedBackend(async () => {
      await send("active turn", `run-local-policy-active-${nextDropPolicy}`);
      await send("first overflowed message", `run-local-policy-first-${nextDropPolicy}`);
      await send("second queued message", `run-local-policy-second-${nextDropPolicy}`);

      dropPolicy = nextDropPolicy;
      cap = 2;
      const third = await send("third queued message", `run-local-policy-third-${nextDropPolicy}`);
      expect(third).toEqual({ runId: `run-local-policy-second-${nextDropPolicy}` });

      active.resolve(agentResult("active done"));
      await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
      const queuedCall = runAgent.mock.calls[1];
      if (!queuedCall) {
        throw new Error("expected queued local followup call");
      }
      const queuedPrompt = (queuedCall[0] as { message: string }).message;
      expect(queuedPrompt).toContain("[Queued messages while agent was busy]");
      expect(queuedPrompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
      expect(queuedPrompt).toContain("first overflowed message");
      expect(queuedPrompt).toContain("second queued message");
      expect(queuedPrompt).toContain("third queued message");
      expect(queuedPrompt.match(/\[Queue overflow\]/g) ?? []).toHaveLength(1);

      collected.resolve(agentResult("collected done"));
      await flushMicrotasks();
    });
  });

  it("interrupts the active local run before starting its replacement", async () => {
    const { onAbort: firstAbortListener } = abortableReply("first aborted");
    runAgent.mockResolvedValueOnce(agentResult("replacement done"));
    mockLocalSession(loadSession, () => ({
      cfg: { messages: { queue: { mode: "interrupt" } } },
    }));
    backend.start();
    await send("first", "run-local-first");
    await send("replace it", "run-local-second");

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
  });

  it("does not inject local queue directives into an active run", async () => {
    const { pending: first, onAbort: firstAbortListener } = abortableReply();
    runAgent.mockResolvedValueOnce(agentResult("queue updated"));
    mockLocalSession(loadSession, () => ({ entry: { queueMode: "interrupt" } }));
    getOperation.mockReturnValue({ sessionId: "active-session" });
    backend.start();
    await send("first", "run-local-first");
    await send("/queue followup", "run-local-queue");

    expect(steer).not.toHaveBeenCalled();
    expect(firstAbortListener).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(2);
    first.resolve(agentResult("first done"));
    await flushMicrotasks();
  });

  it.each(["active", "end"])("stops a local run during %s", async (phase) => {
    const { onAbort: firstAbortListener } = abortableReply("first aborted");

    backend.start();
    await send("first", "run-local-first-terminal");

    registeredListener?.({
      runId: "run-local-first-terminal",
      ...(phase === "end"
        ? { stream: "lifecycle", data: { phase, stopReason: "stop" } }
        : { stream: "assistant", data: { text: "first response", delta: "first response" } }),
    });

    await send("/stop", "run-local-stop-terminal");

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(events).toContainEqual(mainChatEvent("run-local-first-terminal", { state: "aborted" }));
  });

  it.each([
    { name: "retains the latest validation failure", progress: undefined, unsafe: false },
    {
      name: "clears stale diagnostics on assistant progress",
      progress: { stream: "assistant", data: { text: "Recovered" } },
      unsafe: false,
    },
    {
      name: "clears stale diagnostics on tool progress",
      progress: { stream: "tool", data: { phase: "start", name: "read" } },
      unsafe: false,
    },
    { name: "drops unsafe lifecycle diagnostics", progress: undefined, unsafe: true },
  ])("$name when aborting", async ({ progress, unsafe }) => {
    pendingReply(runAgent);
    const runId = "run-validation-loop";
    const summary = "edit tool validation failed: edits: must have required properties edits";
    backend.start();
    await send("edit the file", runId);
    if (!unsafe) {
      emitRunEvent(runId, "tool", { phase: "result", toolErrorSummary: summary });
    }
    if (progress) {
      registeredListener?.({ runId, ...progress });
    }
    emitRunEvent(runId, "lifecycle", {
      phase: "end",
      aborted: true,
      ...(unsafe ? { toolErrorSummary: "browser failed\nsecret output" } : {}),
    });
    await flushMicrotasks();
    expect(events).toContainEqual(
      mainChatEvent(runId, {
        state: "aborted",
        ...(!unsafe && !progress ? { errorMessage: summary } : {}),
      }),
    );
  });

  const structuredLifecycleSecret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
  const structuredLifecycleError = `\u001b[31mThe image is too large. Authorization: Bearer ${structuredLifecycleSecret}\u001b[0m`;

  it.each([
    {
      label: "a provider timeout",
      meta: { stopReason: "timeout", timeoutPhase: "provider", providerStarted: true },
      partialText: "Partial assistant output before the terminal failure.",
      text: "The provider timed out. Please try again.",
    },
    {
      label: "a queued timeout",
      meta: { stopReason: "timeout", timeoutPhase: "queue", providerStarted: false },
      partialText: "Partial assistant output before the terminal failure.",
      text: "The provider timed out. Please try again.",
    },
    {
      label: "a blocked run",
      meta: { livenessState: "blocked" },
      partialText: "Partial assistant output before the terminal failure.",
      text: "Agent run blocked before producing a usable result.",
    },
    {
      label: "an abandoned run",
      meta: { livenessState: "abandoned" },
      partialText: "Partial assistant output before the terminal failure.",
      text: "Agent run ended before producing a complete result.",
    },
    {
      label: "a provider timeout after mechanical cancellation",
      lifecycle: { reason: "transport_cleanup" },
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      text: "The provider timed out. Please try again.",
      partialText: "A partial response before the provider timed out.",
    },
    {
      label: "a non-provider timeout with partial assistant output",
      meta: { stopReason: "timeout" },
      text: "The provider timed out. Please try again.",
      partialText: "A partial response before the run timed out.",
    },
    {
      label: "a mechanically aborted blocked turn",
      lifecycle: {},
      meta: { aborted: true, stopReason: "aborted", livenessState: "blocked" },
      text: "Agent run blocked before producing a usable result.",
      partialText: "A partial response before the run became blocked.",
    },
    {
      label: "an abandoned turn without cancellation",
      lifecycle: {},
      meta: { livenessState: "abandoned" },
      text: "Agent run ended before producing a complete result.",
      partialText: "A partial response before the run was abandoned.",
    },
    {
      label: "a structured agent failure",
      meta: { error: { kind: "image_size", message: "Internal provider diagnostic" } },
      text: "The image is too large. Resize it and try again.",
    },
    {
      label: "a structured lifecycle failure",
      lifecycle: {},
      meta: {
        aborted: false,
        error: { kind: "image_size", message: structuredLifecycleError },
      },
      text: "The image is too large. Authorization: Bearer ***",
      secret: structuredLifecycleSecret,
    },
    {
      label: "an explicit non-aborted failure after controller cancellation",
      abortBeforeLifecycle: true,
      lifecycle: {},
      meta: {
        aborted: false,
        error: { kind: "retry_limit", message: "The provider exhausted its retry limit." },
      },
      text: "The provider exhausted its retry limit.",
    },
  ])(
    "projects $label as an actionable terminal failure",
    async ({ lifecycle, meta, text, partialText, abortBeforeLifecycle, secret }) => {
      const pending = deferred<{
        payloads: Array<{ text: string; mediaUrl: null }>;
        meta: Record<string, unknown>;
      }>();
      runAgent.mockReturnValueOnce(pending.promise);
      backend.start();
      await send("show the actual terminal outcome", "canonical-terminal");
      const queuedRunReady = (
        backend as unknown as { runs: Map<string, { queuedRunReady: Promise<void> }> }
      ).runs.get("canonical-terminal")?.queuedRunReady;
      let queueReady = false;
      void queuedRunReady?.then(() => {
        queueReady = true;
      });

      if (abortBeforeLifecycle) {
        await abortMain("canonical-terminal");
      }
      if (lifecycle) {
        emitRunEvent("canonical-terminal", "lifecycle", { phase: "end", ...meta, ...lifecycle });
        await flushMicrotasks();
        expect(queueReady).toBe(true);
        expect(events).toContainEqual(
          mainChatEvent("canonical-terminal", { state: "error", errorMessage: text }),
        );
      }
      pending.resolve({ payloads: [{ text: partialText ?? text, mediaUrl: null }], meta });
      await flushMicrotasks();

      expect(events).toContainEqual(
        mainChatEvent("canonical-terminal", { state: "error", errorMessage: text }),
      );
      expect(
        events.filter(
          ({ event, payload }) =>
            event === "chat" && (payload as { state?: string }).state === "error",
        ),
      ).toHaveLength(1);
      if (secret) {
        const terminal = events.find(
          ({ event, payload }) =>
            event === "chat" && (payload as { state?: string }).state === "error",
        )?.payload as { errorMessage: string };
        expect(terminal.errorMessage).not.toContain(secret);
        expect(terminal.errorMessage).not.toContain("\u001b");
      }
    },
  );

  it.each([
    { reason: "failed", terminal: { state: "error", errorMessage: "Agent run failed." } },
    { reason: "cancelled", terminal: { state: "aborted" } },
  ] as const)(
    "preserves a wrapped $reason outcome without exposing its cause",
    async ({ reason, terminal }) => {
      const { AgentRunTerminalOutcomeError } =
        await import("../agents/agent-run-terminal-error.js");
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      runAgent.mockRejectedValueOnce(
        new AgentRunTerminalOutcomeError(new Error(`hidden provider credential ${secret}`), {
          reason,
          status: "error",
        }),
      );
      backend.start();

      await send("surface the canonical failure", "error-only-terminal");
      await flushMicrotasks();

      expect(events).toContainEqual(mainChatEvent("error-only-terminal", { ...terminal }));
      expect(JSON.stringify(events)).not.toContain(secret);
    },
  );

  it.each([
    {
      label: "an unrelated completed reason during an actual abort",
      data: { phase: "end", reason: "completed", aborted: true, stopReason: "aborted" },
      terminal: { state: "aborted" },
    },
    {
      label: "an unrelated cancelled reason during an actual provider error",
      data: {
        phase: "end",
        reason: "cancelled",
        aborted: false,
        error: "real provider failure",
      },
      terminal: { state: "error", errorMessage: "real provider failure" },
    },
  ])("ignores $label in open lifecycle event data", async ({ data, terminal }) => {
    const pending = pendingReply(runAgent);
    backend.start();
    await send("trust canonical facts, not an open reason", "open-lifecycle-reason");

    emitRunEvent("open-lifecycle-reason", "lifecycle", data);
    await flushMicrotasks();

    expect(events).toContainEqual(mainChatEvent("open-lifecycle-reason", { ...terminal }));
    pending.resolve(agentResult("the provider finally settled"));
    await flushMicrotasks();
  });

  it("preserves a yielded parent turn in the embedded session projection", async () => {
    const pending = deferred<{
      payloads: Array<{ text: string; mediaUrl: null }>;
      meta: Record<string, unknown>;
    }>();
    runAgent.mockReturnValueOnce(pending.promise);
    backend.start();
    await send("wait for the delegated turn", "yielded-parent");

    emitRunEvent("yielded-parent", "lifecycle", {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
    pending.resolve({
      payloads: [{ text: "Delegated work is continuing.", mediaUrl: null }],
      meta: { yielded: true, livenessState: "paused", stopReason: "end_turn" },
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: expect.objectContaining({
        runId: "yielded-parent",
        state: "final",
        stopReason: "end_turn",
        yielded: true,
      }),
    });
  });

  it.each(["do not do that", "/stop"])(
    "sends idle %s as a prompt with a terminal event",
    async (message) => {
      const pending = await startPendingChat(message, "run-local-idle-stop");

      expect(runAgent).toHaveBeenCalledTimes(1);

      pending.resolve(agentResult("idle stop prompt"));
      await flushMicrotasks();

      expect(events).toContainEqual(
        mainChatEvent("run-local-idle-stop", {
          state: "final",
          message: assistantMessage("idle stop prompt", embeddedEventTimestamp),
        }),
      );
    },
  );

  it("does not stop another agent's selected global local run", async () => {
    const { pending: first, onAbort: firstAbortListener } = abortableReply("main aborted");
    const stop = pendingReply(runAgent);
    backend.start();
    await sendGlobalChat("main", "first", "run-local-main-global-stop");
    await sendGlobalChat("work", "/stop", "run-local-work-global-stop");

    expect(firstAbortListener).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(2);

    first.resolve(agentResult("main done"));
    stop.resolve(agentResult("work stop"));
    await flushMicrotasks();
  });

  it("does not abort selected-global run ids across explicit agent boundaries", async () => {
    getConfig.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    });
    const { pending: defaultRun, onAbort: defaultAbortListener } =
      abortableReply("default aborted");
    const { pending: workRun, onAbort: workAbortListener } = abortableReply("work aborted");
    backend.start();
    await sendGlobalChat("main", "default", "run-local-default-global");
    await sendGlobalChat("work", "work", "run-local-work-global");

    await expect(
      backend.abortChat({
        sessionKey: "global",
        agentId: "work",
        runId: "run-local-default-global",
      }),
    ).resolves.toEqual({ ok: true, aborted: false, runIds: [] });
    await expect(
      backend.abortChat({
        sessionKey: "global",
        agentId: "main",
        runId: "run-local-work-global",
      }),
    ).resolves.toEqual({ ok: true, aborted: false, runIds: [] });

    expect(defaultAbortListener).not.toHaveBeenCalled();
    expect(workAbortListener).not.toHaveBeenCalled();

    defaultRun.resolve(agentResult("default done"));
    workRun.resolve(agentResult("work done"));
    await flushMicrotasks();
  });

  it.each(selectedGlobalSessionCases)(
    "scopes selected global patch policy and result to the stored owner: $input.sessionKey",
    async ({ input, owner }) => {
      const sessionUtils = await import("../gateway/session-utils.js");
      const sessionWorker = await import("../gateway/session-utils-store-worker.js");
      const entry = { sessionId: `session-${owner}`, updatedAt: embeddedEventTimestamp };
      const target = {
        agentId: owner,
        canonicalKey: "global",
        storePath: `/tmp/openclaw-${owner}-sessions.json`,
        storeKeys: ["global"],
        store: { global: entry },
      };
      const resolveTarget = vi
        .spyOn(sessionWorker, "resolveGatewaySessionStoreTargetInWorker")
        .mockResolvedValue(target);
      const resolveCanonical = vi
        .spyOn(sessionUtils, "resolveCanonicalGatewaySessionStoreKey")
        .mockReturnValue({ target, primaryKey: "global", entry });
      projectPatch.mockResolvedValueOnce({ ok: true, entry });
      const patch = {
        key: input.sessionKey,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        fastMode: true,
      };
      try {
        await expect(backend.patchSession(patch)).resolves.toMatchObject({
          ok: true,
          key: "global",
          entry,
        });
        expect
          .soft(projectPatch)
          .toHaveBeenCalledWith(
            expect.objectContaining({ storeKey: "global", agentId: owner, patch }),
          );
        expect.soft(patchResult).toHaveBeenCalledWith({
          canonicalKey: "global",
          cfg: expect.anything(),
          entry,
          preparedAcpMeta: null,
          storePath: target.storePath,
          targetAgentId: owner,
        });
      } finally {
        resolveTarget.mockRestore();
        resolveCanonical.mockRestore();
      }
    },
  );

  it.each([0, 5])("fails a queued send when maintenance exceeds %s ms", async (graceMs) => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: String(graceMs) }, async () => {
      pendingReply(runAgent);

      backend.start();
      await send("first", "run-local-first");

      emitRunEvent("run-local-first", "assistant", { text: "first done", delta: "first done" });
      emitRunEvent("run-local-first", "lifecycle", { phase: "finishing", stopReason: "stop" });

      await send("second", "run-local-second");

      await vi.advanceTimersByTimeAsync(graceMs);
      await flushMicrotasks();

      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "chat",
          payload: expect.objectContaining({
            runId: "run-local-second",
            state: "error",
            errorMessage: expect.stringContaining("timed out waiting for previous local run"),
          }),
        }),
      );
    });
  });

  it("keeps the bounded post-turn timeout visible through canceled queue predecessors", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const active = pendingReply(runAgent);
      mockLocalSession(loadSession, () => ({
        cfg: { messages: { queue: { mode: "followup" } } },
        entry: { queueDebounceMs: 0 },
      }));
      backend.start();
      await send("first", "grace-first");
      await send("second", "grace-second");
      await send("third", "grace-third");

      emitRunEvent("grace-first", "lifecycle", { phase: "finishing", stopReason: "stop" });
      await abortMain("grace-second");
      await vi.advanceTimersByTimeAsync(10);

      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        event: "chat",
        payload: expect.objectContaining({
          runId: "grace-third",
          state: "error",
          errorMessage: expect.stringContaining("timed out waiting for previous local run"),
        }),
      });
      active.resolve(agentResult("first eventually settled"));
      await flushMicrotasks();
    });
  });

  it("clears local finishing state before surfacing a post-turn failure", async () => {
    runAgent
      .mockImplementationOnce(() => {
        emitRunEvent("run-local-first", "lifecycle", { phase: "finishing", stopReason: "stop" });
        throw new Error("post-turn compaction failed");
      })
      .mockResolvedValueOnce(agentResult("second done"));
    let sentDuringError: Promise<{ runId: string }> | undefined;
    backend.onEvent = (evt) => {
      const payload = evt.payload as { runId?: string; state?: string };
      if (
        evt.event === "chat" &&
        payload.runId === "run-local-first" &&
        payload.state === "error"
      ) {
        sentDuringError = send("second", "run-local-second");
      }
    };

    backend.start();
    await send("first", "run-local-first");

    await vi.waitFor(() => expect(sentDuringError).toBeDefined());
    await sentDuringError;
    await flushMicrotasks();
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "every authoritative final payload block",
      finalPayloads: [{ text: "First final block" }, { text: "Second final block" }],
      expectedText: "First final block\n\nSecond final block",
    },
    { name: "streamed text without final text", finalPayloads: [], expectedText: "Draft answer" },
    {
      name: "an ordinary MEDIA-like suffix",
      finalPayloads: [{ text: "The selected size is\nM" }],
      expectedText: "The selected size is\nM",
    },
    {
      name: "generic relative media URLs",
      streamedText: "MEDIA:./image.png",
      mediaUrls: ["./image.png"],
      finalPayloads: [{ text: "MEDIA:./image.png" }],
      expectedText: "MEDIA:./image.png",
    },
    {
      name: "prepared short replies",
      streamedText: "No",
      expectStream: true,
      finalPayloads: [{ text: "No" }],
      expectedText: "No",
    },
    {
      name: "a prepared literal silence marker",
      streamedText: "NO_REPLY",
      expectStream: true,
      finalPayloads: [{ text: "NO_REPLY" }],
      expectedText: "NO_REPLY",
    },
  ])(
    "preserves $name in the final answer",
    async ({
      finalPayloads,
      expectedText,
      streamedText = "Draft answer",
      mediaUrls,
      expectStream,
    }) => {
      const pending = pendingReply(runAgent);
      const runId = "run-local-authoritative-final";
      backend.start();
      await send("finish the draft", runId);
      emitRunEvent(runId, "assistant", { text: streamedText, delta: streamedText, mediaUrls });
      emitRunEvent(runId, "lifecycle", { phase: "end", stopReason: "stop" });
      pending.resolve({ payloads: finalPayloads, meta: {} });
      await flushMicrotasks();
      const chatPayloads = getChatPayloads(events);
      if (expectStream) {
        const nonEmptyDeltas = chatPayloads.filter((entry) => {
          const payload = entry as {
            state?: string;
            message?: { content?: Array<{ text?: string }> };
          };
          return payload.state === "delta" && payload.message?.content?.[0]?.text;
        });
        expect(nonEmptyDeltas).toHaveLength(1);
      }
      expect(chatPayloads.at(-1)).toStrictEqual({
        runId,
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "final",
        stopReason: "stop",
        message: assistantMessage(expectedText, embeddedEventTimestamp),
      });
    },
  );

  registerEmbeddedBackendStreamTests({
    createBackend: () => new EmbeddedTuiBackend(),
    runAgent,
    emitAgentEvent: (event) => registeredListener?.(event),
    embeddedEventTimestamp,
  });

  it.each([
    ["unkeyed fallback", false, 1, "fallback answer", "fallback answer", undefined],
    ["item fallback", false, 1, "fallback answer", "fallback answer", "answer"],
    ["repeated expired failures", true, 2, "recovered answer", "recovered answer", undefined],
    [
      "authoritative streamed final",
      true,
      1,
      "outdated draft",
      "authoritative final answer",
      undefined,
    ],
    [
      "authoritative unstreamed final",
      true,
      1,
      undefined,
      "authoritative unstreamed answer",
      undefined,
    ],
    [
      "item recovery after expiry",
      true,
      2,
      "recovered item answer",
      "recovered item answer",
      "answer",
    ],
  ] as const)(
    "recovers %s",
    async (_name, expired, failureCount, streamedText, finalText, itemId) => {
      const pending = pendingReply(runAgent);
      const runId = expired ? "run-local-expired-retry-" + failureCount : "run-local-fallback";
      backend.start();
      await send(expired ? "recover after a slow retry" : "recover after timeout", runId);
      for (let attempt = 0; attempt < failureCount; attempt += 1) {
        if (itemId) {
          for (const data of [
            {
              itemId: "prefix",
              text: expired ? "Discarded attempt " + (attempt + 1) + ": " : "Discarded attempt: ",
            },
            { itemId, text: "draft answer" },
          ]) {
            emitRunEvent(runId, "assistant", data);
          }
        }
        emitRunEvent(runId, "lifecycle", {
          phase: "error",
          error: expired
            ? "retryable provider failure " + (attempt + 1)
            : "primary model timed out",
        });
        if (expired) {
          await vi.advanceTimersByTimeAsync(15_000);
        } else {
          await flushMicrotasks();
        }
      }
      expect(getChatPayloads(events).some((payload) => payload.state === "error")).toBe(expired);
      if (!expired) {
        emitRunEvent(runId, "lifecycle", {
          phase: "fallback_step",
          fallbackStepFinalOutcome: "succeeded",
          fallbackStepFromModel: "anthropic/claude-sonnet-4-6",
          fallbackStepToModel: "anthropic/claude-sonnet-4-5",
        });
      }
      if (streamedText) {
        emitRunEvent(runId, "assistant", { itemId, text: streamedText, delta: streamedText });
        expect(events.at(-1)).toMatchObject({
          event: "chat",
          payload: { state: "delta", message: { content: [{ text: streamedText }] } },
        });
      }
      emitRunEvent(runId, "lifecycle", { phase: "end", stopReason: "stop" });
      pending.resolve(agentResult(finalText));
      await flushMicrotasks();
      if (!expired) {
        vi.advanceTimersByTime(15_001);
      }
      const terminalEvents = getChatPayloads(events).filter(
        (payload) => payload.state === "error" || payload.state === "final",
      );
      expect(terminalEvents.map((payload) => payload.state)).toEqual(
        expired ? ["error", "final"] : ["final"],
      );
      expect(terminalEvents.at(-1)).toMatchObject({
        state: "final",
        message: { content: [{ type: "text", text: finalText }] },
      });
    },
  );

  it("finalizes exhausted fallback failures without waiting for retry grace", async () => {
    const pending = pendingReply(runAgent);
    const runId = "run-local-exhausted-fallback";

    backend.start();
    await send("fail after all fallbacks", runId);
    emitRunEvent(runId, "lifecycle", {
      phase: "error",
      error: "All fallback candidates failed",
      fallbackExhaustedFailure: true,
    });
    expect(events.at(-1)).toMatchObject({
      event: "chat",
      payload: { state: "error", errorMessage: "All fallback candidates failed" },
    });

    pending.reject(new Error("All fallback candidates failed"));
    await flushMicrotasks();
  });

  it.each([
    { command: "btw", text: "nothing important", timeoutMs: 0 },
    { command: "side", text: "alias answer", timeoutMs: undefined },
  ])("emits side-result events for local /$command runs", async ({ command, text, timeoutMs }) => {
    const entry = { sessionId: "session-main", updatedAt: Date.now() };
    loadSession.mockReturnValueOnce(
      localSessionEntry("agent:main:main", undefined, {
        entry,
        store: { "agent:main:main": entry },
      }),
    );
    runSideQuestion.mockResolvedValueOnce({ text });
    const runId = `run-${command}-1`;

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: `/${command} what changed?`,
      runId,
      timeoutMs,
    });
    await flushMicrotasks();

    await vi.waitFor(() => expect(runSideQuestion).toHaveBeenCalledTimes(1));
    expect(runAgent).not.toHaveBeenCalled();
    expect(runSideQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        question: "what changed?",
        sessionKey: "agent:main:main",
        ...(timeoutMs === 0
          ? { opts: expect.objectContaining({ timeoutOverrideSeconds: 0 }) }
          : {}),
        isNewSession: false,
      }),
    );
    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId,
          sessionKey: "agent:main:main",
          agentId: "main",
          question: "what changed?",
          text,
        },
      },
      mainChatEvent(runId, { state: "final" }),
    ]);
  });

  it("registers tool-first local runs before forwarding agent events", async () => {
    const pending = await startPendingChat("run tool first", "run-tool-first");

    emitRunEvent("run-tool-first", "tool", {
      phase: "start",
      toolCallId: "tc-tool-first",
      name: "exec",
    });
    pending.resolve(agentResult("done"));
    await flushMicrotasks();

    expect(events).toEqual([
      mainChatEvent("run-tool-first", {
        state: "delta",
        deltaText: "",
        message: assistantMessage("", embeddedEventTimestamp),
      }),
      {
        event: "agent",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
        },
      },
      mainChatEvent("run-tool-first", {
        state: "final",
        message: assistantMessage("done", embeddedEventTimestamp),
      }),
    ]);
  });

  it("keeps local BTW runs alive during a session-scoped abort", async () => {
    loadSession.mockReturnValue(storedSession({ store: {}, entry: { sessionId: "session-main" } }));
    const mainRun = deferred<{ payloads: Array<{ text: string }>; meta: { aborted?: boolean } }>();
    const btwRun = deferred<{ text: string }>();
    let mainSignal: AbortSignal | undefined;
    let btwSignal: AbortSignal | undefined;
    runAgent.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      mainSignal = opts.abortSignal;
      opts.abortSignal?.addEventListener(
        "abort",
        () => mainRun.resolve(agentResult(undefined, { aborted: true })),
        { once: true },
      );
      return mainRun.promise;
    });
    runSideQuestion.mockImplementationOnce((params: { opts?: { abortSignal?: AbortSignal } }) => {
      btwSignal = params.opts?.abortSignal;
      return btwRun.promise;
    });
    backend.start();
    await send("long task", "run-main-abort");
    await send("/btw what changed?", "run-btw-survives");
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(runSideQuestion).toHaveBeenCalledTimes(1);
    });

    const result = await abortMain();

    expect(result).toEqual({ ok: true, aborted: true, runIds: ["run-main-abort"] });
    expect(mainSignal?.aborted).toBe(true);
    expect(btwSignal?.aborted).toBe(false);

    btwRun.resolve({ text: "still running" });
    await flushMicrotasks();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
