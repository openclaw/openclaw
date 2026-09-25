import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { Result } from "@openclaw/normalization-core/result";
import { expect, vi } from "vitest";
import type { SessionProjectionState } from "../../packages/gateway-client/src/session-projection.js";
import type { TuiBackend } from "./tui-backend.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import type { TuiPendingSubmit } from "./tui-submit-state.js";
import type { SessionInfo, TuiOptions } from "./tui-types.js";

export type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type RunAuthFlow = NonNullable<Parameters<typeof createCommandHandlers>[0]["runAuthFlow"]>;
type AbortActiveMock = ReturnType<typeof vi.fn> &
  ((params?: { preferActive?: boolean }) => Promise<void>);
export type SelectableOverlay = {
  items?: Array<{ value: string; label?: string; description?: string }>;
  onSelect?: (item: { value: string; label?: string; description?: string }) => void;
  render: (width: number) => string[];
  handleInput: (data: string) => void;
};
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
export type SetSessionMock = ReturnType<typeof vi.fn> &
  ((key: string, agentId?: string) => Promise<void>);
export type ConsumeCompletedRunMock = ReturnType<typeof vi.fn> & ((runId: string) => boolean);
type FlushPendingHistoryRefreshMock = ReturnType<typeof vi.fn> & (() => void);
export type RefreshAgentsMock = ReturnType<typeof vi.fn> & (() => Promise<Result<void, string>>);

function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
    getBounds: () => undefined,
  };
}

export async function flushAsyncSelect() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function expectSendChatFields(
  sendChat: ReturnType<typeof vi.fn>,
  expected: { message: string; agentId?: string; sessionId?: string; sessionKey?: string },
) {
  const calls = sendChat.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected gateway sendChat call");
  }
  const payload = call[0] as {
    message?: unknown;
    agentId?: unknown;
    sessionId?: unknown;
    sessionKey?: unknown;
  };
  expect(payload.message).toBe(expected.message);
  if (expected.agentId !== undefined) {
    expect(payload.agentId).toBe(expected.agentId);
  }
  if (expected.sessionId !== undefined) {
    expect(payload.sessionId).toBe(expected.sessionId);
  }
  if (expected.sessionKey !== undefined) {
    expect(payload.sessionKey).toBe(expected.sessionKey);
  }
}

type MockWithCalls = { mock: { calls: unknown[][] } };

export function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

export function createTuiCommandHandlersHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  getGatewayStatus?: ReturnType<typeof vi.fn>;
  listSessions?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
  getKnownModels?: TuiBackend["getKnownModels"];
  patchSession?: ReturnType<typeof vi.fn>;
  createSession?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  runGoalCommand?: ReturnType<typeof vi.fn>;
  runUsageCostCommand?: ReturnType<typeof vi.fn> | null;
  runAuthFlow?: RunAuthFlow;
  localCli?: Parameters<typeof createCommandHandlers>[0]["localCli"];
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  refreshSessionInfo?: ReturnType<typeof vi.fn>;
  applySessionInfoFromPatch?: ReturnType<typeof vi.fn>;
  applySessionMutationResult?: ReturnType<typeof vi.fn>;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
  pendingSubmit?: TuiPendingSubmit | null;
  activityStatus?: string;
  opts?: Pick<TuiOptions, "local" | "timeoutMs">;
  currentSessionId?: string | null;
  sessionGeneration?: number;
  currentAgentId?: string;
  currentSessionKey?: string;
  sessionProjection?: SessionProjectionState;
  sessionInfo?: SessionInfo;
  abortActive?: AbortActiveMock;
  consumeCompletedRunForPendingSend?: ConsumeCompletedRunMock;
  isRunObserved?: (runId: string) => boolean;
  flushPendingHistoryRefreshIfIdle?: FlushPendingHistoryRefreshMock;
  reopenQuestion?: () => void;
  refreshAgents?: RefreshAgentsMock;
  agentDefaultId?: string;
  agents?: Array<{ id: string; kind?: "agent" | "system"; name?: string }>;
}) {
  const sendChat =
    params?.sendChat ??
    vi.fn().mockImplementation(async (opts: { runId?: string }) => ({ runId: opts.runId ?? "r1" }));
  const getGatewayStatus = params?.getGatewayStatus ?? vi.fn().mockResolvedValue({});
  const listSessions = params?.listSessions ?? vi.fn().mockResolvedValue({ sessions: [] });
  const listModels = params?.listModels ?? vi.fn().mockResolvedValue([]);
  const patchSession = params?.patchSession ?? vi.fn().mockResolvedValue({});
  const createSession =
    params?.createSession ??
    vi.fn().mockImplementation(async (opts: { key: string }) => ({
      ok: true,
      key: `agent:main:${opts.key}`,
    }));
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const runGoalCommand = params?.runGoalCommand ?? vi.fn().mockResolvedValue({ text: "Goal" });
  const runUsageCostCommand =
    params?.runUsageCostCommand === null
      ? undefined
      : (params?.runUsageCostCommand ?? vi.fn().mockResolvedValue({ text: "💸 Usage cost" }));
  const setSession =
    params?.setSession ??
    (vi.fn(async (_key: string, agentId?: string) => {
      if (agentId) {
        state.currentAgentId = agentId;
      }
    }) as SetSessionMock);
  const addUser = vi.fn();
  const addPendingUser = vi.fn();
  const dropPendingUser = vi.fn();
  const rekeyPendingUser = vi.fn();
  const addSystem = vi.fn();
  const clearTools = vi.fn();
  const reserveAssistantSlot = vi.fn();
  const requestRender = vi.fn();
  const noteLocalRunId = vi.fn();
  const noteLocalBtwRunId = vi.fn();
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const refreshSessionInfo = params?.refreshSessionInfo ?? vi.fn().mockResolvedValue(undefined);
  const applySessionInfoFromPatch = params?.applySessionInfoFromPatch ?? vi.fn();
  const applySessionMutationResult = params?.applySessionMutationResult ?? vi.fn();
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);
  const forgetLocalRunId = vi.fn();
  const forgetLocalBtwRunId = vi.fn();
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn(() => overlayHandle);
  const closeOverlay = vi.fn();
  const requestExit = vi.fn();
  const abortActive =
    params?.abortActive ?? (vi.fn().mockResolvedValue(undefined) as AbortActiveMock);
  const refreshAgents =
    params?.refreshAgents ??
    (vi.fn().mockResolvedValue({ ok: true, value: undefined }) as RefreshAgentsMock);
  const runAuthFlow: RunAuthFlow | undefined =
    params?.runAuthFlow ??
    (params?.opts?.local
      ? (vi.fn().mockResolvedValue({
          exitCode: 0,
          signal: null,
          commandArgv: '["codex","login"]',
        }) as unknown as RunAuthFlow)
      : undefined);
  const state = {
    agentDefaultId: params?.agentDefaultId ?? "main",
    agents: params?.agents ?? [],
    currentAgentId: params?.currentAgentId ?? "main",
    currentSessionKey: params?.currentSessionKey ?? "agent:main:main",
    currentSessionId: params?.currentSessionId ?? null,
    sessionGeneration: params?.sessionGeneration ?? 0,
    sessionProjection: params?.sessionProjection,
    activeChatRunId: params?.activeChatRunId ?? null,
    pendingSubmit: params?.pendingSubmit ?? null,
    activityStatus: params?.activityStatus ?? "idle",
    isConnected: params?.isConnected ?? true,
    sessionInfo: params?.sessionInfo ?? {},
  };

  const modelEvents: Pick<TuiBackend, "onModelsChanged"> = {};
  const client = {
    ...modelEvents,
    sendChat,
    getGatewayStatus,
    listSessions,
    listModels,
    getKnownModels: params?.getKnownModels,
    patchSession,
    createSession,
    resetSession,
    runGoalCommand,
    runUsageCostCommand,
  };
  const {
    handleCommand,
    sendMessage,
    captureMessageAdmission,
    resolveMessageAdmission,
    reportBlockedMessageSubmit,
    openSessionSelector,
  } = createCommandHandlers({
    client: client as never,
    chatLog: {
      addUser,
      addPendingUser,
      dropPendingUser,
      rekeyPendingUser,
      addSystem,
      clearTools,
      reserveAssistantSlot,
    } as never,
    tui: { requestRender } as never,
    opts: params?.opts ?? {},
    state: state as never,
    deliverDefault: false,
    openOverlay,
    closeOverlay,
    refreshSessionInfo: refreshSessionInfo as never,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: applySessionInfoFromPatch as never,
    applySessionMutationResult: applySessionMutationResult as never,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    forgetLocalBtwRunId,
    consumeCompletedRunForPendingSend: params?.consumeCompletedRunForPendingSend,
    isRunObserved: params?.isRunObserved,
    flushPendingHistoryRefreshIfIdle: params?.flushPendingHistoryRefreshIfIdle,
    runAuthFlow,
    localCli: params?.localCli,
    requestExit,
    reopenQuestion: params?.reopenQuestion,
  });

  return {
    client,
    handleCommand,
    sendMessage,
    captureMessageAdmission,
    resolveMessageAdmission,
    reportBlockedMessageSubmit,
    getGatewayStatus,
    listSessions,
    listModels,
    sendChat,
    openSessionSelector,
    openOverlay,
    overlayHandle,
    closeOverlay,
    patchSession,
    createSession,
    resetSession,
    runGoalCommand,
    runUsageCostCommand,
    setSession,
    addUser,
    addPendingUser,
    dropPendingUser,
    rekeyPendingUser,
    addSystem,
    clearTools,
    reserveAssistantSlot,
    requestRender,
    loadHistory,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    applySessionMutationResult,
    runAuthFlow,
    setActivityStatus,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    forgetLocalBtwRunId,
    requestExit,
    abortActive,
    refreshAgents,
    state,
  };
}
