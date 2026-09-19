/**
 * HTTP server session fixtures shared by gateway session tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { registerAcpSessionResetControls } from "../../acp/control-plane/manager.reset-controls.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { InternalHookEvent } from "../../hooks/internal-hooks.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "../server-methods/session-change-event.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "../server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { embeddedRunMock, testState } from "../test-helpers.runtime-state.js";
import * as gatewayTestHelpers from "../test-helpers.server.js";
import {
  installGatewaySessionsTestResources,
  type GatewaySessionsSuiteSetup,
} from "./server-sessions-resources.test-helpers.js";

export {
  createCheckpointFixture,
  getSessionManagerModule,
} from "./server-sessions-checkpoint.test-helpers.js";

export const getGatewayConfigModule = createLazyRuntimeModule(
  () => import("../../config/config.js"),
);

const getSessionAccessorModule = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.js"),
);

const getGatewayServerMethodsModule = createLazyRuntimeModule(() => import("../server-methods.js"));

export async function getSessionsHandlers() {
  return (await getGatewayServerMethodsModule()).coreGatewayHandlers;
}

type TestTranscriptMessage = Record<string, unknown> & {
  role: string;
};
type RetireSessionMcpRuntimeParams = Parameters<
  (typeof import("../../agents/agent-bundle-mcp-tools.js"))["retireSessionMcpRuntime"]
>[0];

export async function seedSessionTranscript(params: {
  agentId?: string;
  messages: readonly TestTranscriptMessage[];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const { persistSessionTranscriptTurn } = await getSessionAccessorModule();
  await persistSessionTranscriptTurn(
    {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: params.messages.map((message, index) => ({
        message: {
          timestamp: index + 1,
          ...message,
        },
        now: Date.parse(`2026-06-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`),
      })),
    },
  );
}

export async function seedLinearSessionTranscript(params: {
  agentId?: string;
  contents: readonly string[];
  role?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await seedSessionTranscript({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    messages: params.contents.map((content) => ({
      role: params.role ?? "user",
      content,
    })),
  });
}

export async function loadSeededTranscriptEvents(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  const { loadTranscriptEvents } = await getSessionAccessorModule();
  return await loadTranscriptEvents({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

const sessionCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn((keys: Array<string | undefined>) => {
    const clearedKeys = Array.from(
      new Set(
        keys
          .map((key) => (typeof key === "string" ? key.trim() : ""))
          .filter((key) => key.length > 0),
      ),
    );
    return { followupCleared: 0, laneCleared: 0, keys: clearedKeys };
  }),
  stopSessionResetSubagents: vi.fn(async () => {}),
}));

const bootstrapCacheMocks = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
}));

const sessionHookMocks = vi.hoisted(() => ({
  hasInternalHookListeners: vi.fn(() => true),
  triggerInternalHook: vi.fn(async (_eventValue: unknown) => {}),
}));

const beforeResetHookMocks = vi.hoisted(() => ({
  runBeforeReset: vi.fn(async () => {}),
}));

const sessionLifecycleHookMocks = vi.hoisted(() => ({
  runSessionEnd: vi.fn(async () => {}),
  runSessionStart: vi.fn(async () => {}),
}));

const subagentLifecycleHookMocks = vi.hoisted(() => ({
  runSubagentEnded: vi.fn(async () => {}),
}));

const beforeResetHookState = vi.hoisted(() => ({
  hasBeforeResetHook: false,
}));

const sessionLifecycleHookState = vi.hoisted(() => ({
  hasSessionEndHook: true,
  hasSessionStartHook: true,
}));

const subagentLifecycleHookState = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
}));

const threadBindingMocks = vi.hoisted(() => ({
  unbindThreadBindingsBySessionKey: vi.fn(async (_params?: unknown) => []),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getAcpRuntimeBackend: vi.fn(),
  requireAcpRuntimeBackend: vi.fn(),
}));
const acpManagerMocks = vi.hoisted(() => ({
  captureSessionRuntimeOwnership: vi.fn(() => ({ isCurrent: () => true, release: vi.fn() })),
  cancelSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  forceDiscardSessionRuntime: vi.fn(async () => {}),
}));
registerAcpSessionResetControls(acpManagerMocks, acpManagerMocks);
const browserSessionTabMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));
const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  disposeSessionMcpRuntime: vi.fn(async (_sessionId: string) => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  retireSessionMcpRuntime: vi.fn(async (_params: RetireSessionMcpRuntimeParams) => true),
}));

vi.mock("../../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue.js")>(
    "../../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../../auto-reply/reply/queue/cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue/cleanup.js")>(
    "../../auto-reply/reply/queue/cleanup.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../../auto-reply/reply/session-reset-cleanup.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/session-reset-cleanup.js")
  >("../../auto-reply/reply/session-reset-cleanup.js");
  return {
    ...actual,
    stopSessionResetSubagents: sessionCleanupMocks.stopSessionResetSubagents,
  };
});

vi.mock("../../agents/bootstrap-cache.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/bootstrap-cache.js")>(
    "../../agents/bootstrap-cache.js",
  );
  return {
    ...actual,
    clearBootstrapSnapshot: bootstrapCacheMocks.clearBootstrapSnapshot,
  };
});

vi.mock("../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
    "../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    hasInternalHookListeners: sessionHookMocks.hasInternalHookListeners,
    triggerInternalHook: sessionHookMocks.triggerInternalHook,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/hook-runner-global.js")>(
    "../../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(() => ({
      hasHooks: (hookName: string) =>
        (hookName === "subagent_ended" && subagentLifecycleHookState.hasSubagentEndedHook) ||
        (hookName === "before_reset" && beforeResetHookState.hasBeforeResetHook) ||
        (hookName === "session_end" && sessionLifecycleHookState.hasSessionEndHook) ||
        (hookName === "session_start" && sessionLifecycleHookState.hasSessionStartHook),
      runBeforeReset: beforeResetHookMocks.runBeforeReset,
      runSessionEnd: sessionLifecycleHookMocks.runSessionEnd,
      runSessionStart: sessionLifecycleHookMocks.runSessionStart,
      runSubagentEnded: subagentLifecycleHookMocks.runSubagentEnded,
    })),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => ({
      ...actual.getSessionBindingService(),
      unbind: async (params: unknown) =>
        threadBindingMocks.unbindThreadBindingsBySessionKey(params),
    }),
  };
});

vi.mock("../../acp/runtime/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../acp/runtime/registry.js")>(
    "../../acp/runtime/registry.js",
  );
  return {
    ...actual,
    getAcpRuntimeBackend: acpRuntimeMocks.getAcpRuntimeBackend,
    requireAcpRuntimeBackend: (backendId?: string) => {
      const backend = acpRuntimeMocks.requireAcpRuntimeBackend(backendId);
      if (!backend) {
        throw new Error("missing mocked ACP backend");
      }
      return backend;
    },
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => acpManagerMocks,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserSessionTabMocks.closeTrackedBrowserTabsForSessions,
  movePathToTrash: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal()),
  disposeSessionMcpRuntime: bundleMcpRuntimeMocks.disposeSessionMcpRuntime,
  disposeAllSessionMcpRuntimes: bundleMcpRuntimeMocks.disposeAllSessionMcpRuntimes,
  retireSessionMcpRuntime: bundleMcpRuntimeMocks.retireSessionMcpRuntime,
}));

export function setupGatewaySessionsHandlerTestHarness(setup?: GatewaySessionsSuiteSetup) {
  const { getHarness, openClient, ...handlerFixture } = createGatewaySessionsTestHarness(
    false,
    setup,
  );
  void [getHarness, openClient];
  return handlerFixture;
}

export function setupGatewaySessionsTestHarness(setup?: GatewaySessionsSuiteSetup) {
  return createGatewaySessionsTestHarness(true, setup);
}

function createGatewaySessionsTestHarness(startServer: boolean, setup?: GatewaySessionsSuiteSetup) {
  const { defaultAgentWorkspace, requireHarness, requireSharedSessionStoreDir } =
    installGatewaySessionsTestResources(startServer, setup);
  afterEach(disposeSessionReadContexts);
  let sessionStoreCaseSeq = 0;

  beforeEach(async () => {
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    sessionCleanupMocks.clearSessionQueues.mockClear();
    sessionCleanupMocks.stopSessionResetSubagents.mockClear();
    bootstrapCacheMocks.clearBootstrapSnapshot.mockReset();
    sessionHookMocks.hasInternalHookListeners.mockReset();
    sessionHookMocks.hasInternalHookListeners.mockReturnValue(true);
    sessionHookMocks.triggerInternalHook.mockClear();
    beforeResetHookMocks.runBeforeReset.mockClear();
    beforeResetHookState.hasBeforeResetHook = false;
    sessionLifecycleHookMocks.runSessionEnd.mockClear();
    sessionLifecycleHookMocks.runSessionStart.mockClear();
    sessionLifecycleHookState.hasSessionEndHook = true;
    sessionLifecycleHookState.hasSessionStartHook = true;
    subagentLifecycleHookMocks.runSubagentEnded.mockClear();
    subagentLifecycleHookState.hasSubagentEndedHook = true;
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockClear();
    resetSystemEventsForTest();
    acpRuntimeMocks.cancel.mockClear();
    acpRuntimeMocks.close.mockClear();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue(null);
    acpRuntimeMocks.requireAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.requireAcpRuntimeBackend.mockImplementation((backendId?: string) =>
      acpRuntimeMocks.getAcpRuntimeBackend(backendId),
    );
    Object.values(acpManagerMocks).forEach((mock) => mock.mockClear());
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockClear();
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockResolvedValue(undefined);
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockReset();
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async ({ sessionId }) => {
      if (!sessionId) {
        return false;
      }
      await bundleMcpRuntimeMocks.disposeSessionMcpRuntime(sessionId);
      return true;
    });
  });

  const openClient = async (opts?: Parameters<typeof gatewayTestHelpers.connectOk>[1]) => {
    await gatewayTestHelpers.prepareGatewayReplyRuntimeForTest({ force: true });
    return await requireHarness().openClient(opts);
  };

  async function createSessionStoreDir() {
    const dir = path.join(requireSharedSessionStoreDir(), `case-${sessionStoreCaseSeq++}`);
    await fs.mkdir(dir, { recursive: true });
    testState.sessionStorePath = path.join(dir, "sessions.json");
    (await getGatewayConfigModule()).clearRuntimeConfigSnapshot(); // A suite server may prewarm before case setup.
    return { dir, storePath: testState.sessionStorePath };
  }

  async function createSelectedGlobalSessionStore() {
    const { dir } = await createSessionStoreDir();
    const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "global" };
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
    return {
      dir,
      storeTemplate,
      mainStorePath: storeTemplate.replace("{agentId}", "main"),
      workStorePath: storeTemplate.replace("{agentId}", "work"),
    };
  }

  async function createConfiguredGlobalAgentSessionStore({
    writePrimeStore = false,
    withTranscripts = false,
  }: {
    writePrimeStore?: boolean;
    withTranscripts?: boolean;
  } = {}) {
    const { dir } = await createSessionStoreDir();
    const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "global" };
    if (writePrimeStore) {
      await gatewayTestHelpers.writeSessionStore({
        entries: {},
        storePath: path.join(dir, "prime-sessions.json"),
      });
    }

    const mainStorePath = storeTemplate.replace("{agentId}", "main");
    const workStorePath = storeTemplate.replace("{agentId}", "work");
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(workStorePath), { recursive: true });
    await gatewayTestHelpers.writeSessionStore({
      agentId: "main",
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
      storePath: mainStorePath,
    });
    await gatewayTestHelpers.writeSessionStore({
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global", {
          authProfileOverride: "github-copilot:work",
        }),
      },
      storePath: workStorePath,
    });
    if (withTranscripts) {
      await seedLinearSessionTranscript({
        agentId: "main",
        contents: ["main one", "main two"],
        sessionId: "sess-main-global",
        sessionKey: "global",
        storePath: mainStorePath,
      });
      await seedLinearSessionTranscript({
        agentId: "work",
        contents: ["work one", "work two"],
        sessionId: "sess-work-global",
        sessionKey: "global",
        storePath: workStorePath,
      });
    }

    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is required");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          session: { scope: "global", store: storeTemplate },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
      await getGatewayConfigModule();
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    return {
      clearConfigCache,
      clearRuntimeConfigSnapshot,
      configPath,
      getRuntimeConfig,
      mainStorePath,
      workStorePath,
    };
  }

  async function resetConfiguredGlobalAgentSessionStore({
    clearConfigCache,
    clearRuntimeConfigSnapshot,
    configPath,
  }: {
    clearConfigCache: () => void;
    clearRuntimeConfigSnapshot: () => void;
    configPath: string;
  }) {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    await fs.writeFile(configPath, "{}\n", "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }

  async function seedActiveMainSession() {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await gatewayTestHelpers.writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-main"),
      },
    });
    return { dir, storePath };
  }

  return {
    createConfiguredGlobalAgentSessionStore,
    createSessionStoreDir,
    createSelectedGlobalSessionStore,
    defaultAgentWorkspace,
    getHarness: requireHarness,
    openClient,
    resetConfiguredGlobalAgentSessionStore,
    seedActiveMainSession,
  };
}

export async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

export function sessionStoreEntry(sessionId: string, overrides: Partial<SessionEntry> = {}) {
  return {
    sessionId,
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function expectActiveRunCleanup(
  requesterSessionKey: string,
  expectedQueueKeys: string[],
  sessionId: string,
  requesterAgentId: string,
) {
  expect(sessionCleanupMocks.stopSessionResetSubagents).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: expect.any(Object),
      sessionKey: requesterSessionKey,
      agentId: requesterAgentId,
    }),
  );
  expectSessionQueueCleanup(expectedQueueKeys);
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(embeddedRunMock.waitCalls).toEqual([sessionId]);
}

function expectSessionQueueCleanup(expectedQueueKeys: string[]) {
  expect(sessionCleanupMocks.clearSessionQueues).toHaveBeenCalledTimes(1);
  const clearedKeys = (
    sessionCleanupMocks.clearSessionQueues.mock.calls as unknown as Array<[string[]]>
  )[0]?.[0];
  for (const key of expectedQueueKeys) {
    expect(clearedKeys).toContain(key);
  }
}

export function expectNoSessionQueueCleanup() {
  expect(sessionCleanupMocks.clearSessionQueues).not.toHaveBeenCalled();
}

type SessionsHandlers = Awaited<ReturnType<typeof getSessionsHandlers>>;
type SessionsHandlerOptions = Parameters<SessionsHandlers[keyof SessionsHandlers]>[0];

const defaultDirectContext = {};
const directContexts = new Map<object, GatewayRequestContext>();
beforeEach(() => directContexts.clear());

export async function directSessionReq<TPayload = unknown>(
  method: keyof SessionsHandlers,
  params: Record<string, unknown>,
  opts?: {
    context?: Record<string, unknown>;
    client?: SessionsHandlerOptions["client"];
    isWebchatConnect?: SessionsHandlerOptions["isWebchatConnect"];
    sessionMutationAuthorization?: SessionsHandlerOptions["sessionMutationAuthorization"];
    coercePayload?: (payload: unknown) => TPayload;
  },
): Promise<{
  ok: boolean;
  payload?: TPayload;
  error?: { code?: string; message?: string; details?: unknown };
}> {
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  let result:
    | {
        ok: boolean;
        payload?: TPayload;
        error?: { code?: string; message?: string; details?: unknown };
      }
    | undefined;
  const handler = sessionsHandlers[method];
  if (!handler) {
    throw new Error(`missing sessions handler for ${method}`);
  }
  const contextFields: GatewayRequestContext = createDirectChatContext({
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    readPreparedGatewayModelCatalog: async () => {
      const catalog = await contextFields.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    },
    getRuntimeConfig,
    ...opts?.context,
  });
  const contextKey = opts?.context ?? defaultDirectContext;
  const context = directContexts.get(contextKey) ?? createDirectChatContext();
  Object.assign(context, contextFields);
  directContexts.set(contextKey, context);
  if (
    [
      "chat.startup",
      "chat.history",
      "sessions.list",
      "sessions.describe",
      "sessions.resolve",
      "sessions.create",
      "sessions.patch",
      "sessions.patchMany",
      "sessions.compact",
    ].includes(method)
  ) {
    await initializeSessionReadContext(context);
  }
  await handler({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = {
        ok,
        payload:
          payload === undefined
            ? undefined
            : opts?.coercePayload
              ? opts.coercePayload(payload)
              : (payload as TPayload),
        error,
      };
    },
    context,
    client: opts?.client ?? null,
    isWebchatConnect: opts?.isWebchatConnect ?? (() => false),
    sessionMutationAuthorization: opts?.sessionMutationAuthorization,
  });
  await flushPendingSessionsChangedEvents(context);
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

export function isInternalHookEvent(value: unknown): value is InternalHookEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.messages) &&
    typeof candidate.context === "object" &&
    candidate.context !== null
  );
}

export {
  bootstrapCacheMocks,
  sessionHookMocks,
  beforeResetHookMocks,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  beforeResetHookState,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpRuntimeMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
};
