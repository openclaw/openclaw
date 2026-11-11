import { onTestFinished, vi } from "vitest";
import {
  createTuiProgramStatusReporter,
  type SetTuiActivityStatus,
} from "./tui-activity-status.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createMockBtwPresenter,
  createMockChatLog,
  makeTuiState,
} from "./tui-event-test-support.js";
import type {
  AgentEvent,
  ChatEvent,
  SessionChangedEvent,
  SessionMessageEvent,
  TuiHistoryLoadResult,
  TuiStateAccess,
} from "./tui-types.js";

export type ChatEventOverrides = Partial<ChatEvent> & { stopReason?: unknown };

function makeChatEvent(state: TuiStateAccess, overrides: ChatEventOverrides = {}): ChatEvent {
  return { runId: "run-1", sessionKey: state.currentSessionKey, state: "delta", ...overrides };
}

export function textEvent(
  runId: string,
  text: string,
  state: ChatEvent["state"] = "delta",
): ChatEventOverrides {
  return { runId, state, message: { content: [{ type: "text", text }] } };
}

function makeAgentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return { runId: "run-1", stream: "lifecycle", data: { phase: "start" }, ...overrides };
}

export const createTuiEventHandlersHarness = (
  params?: Partial<TuiStateAccess> & {
    localMode?: boolean;
    refreshSessionInfo?: () => Promise<void>;
    streamingWatchdogMs?: number;
  },
  loadHistory = vi.fn<() => Promise<TuiHistoryLoadResult>>(async () => ({
    loaded: true,
    runOutcome: { state: "completed" },
  })),
) => {
  const { localMode, refreshSessionInfo, streamingWatchdogMs, ...overrides } = params ?? {};
  const state = makeTuiState({ activeChatRunId: "run-1", ...overrides });
  const programStates: string[] = [];
  const programStatus = createTuiProgramStatusReporter({
    setProgramStatus: ({ state: programState }) => programStates.push(programState),
  });
  const localRunIds = new Set<string>();
  const localBtwRunIds = new Set<string>();
  const context = {
    state,
    chatLog: createMockChatLog(),
    btw: createMockBtwPresenter(),
    tui: { requestRender: vi.fn() },
    setActivityStatus: vi.fn<SetTuiActivityStatus>((activityStatus, runOutcome) => {
      programStatus.update({ activityStatus, isConnected: state.isConnected, runOutcome });
    }),
    updateFooter: vi.fn(),
    loadHistory,
    noteLocalRunId: (runId: string) => {
      localRunIds.add(runId);
    },
    noteLocalBtwRunId: (runId: string) => {
      localBtwRunIds.add(runId);
    },
    forgetLocalRunId: localRunIds.delete.bind(localRunIds),
    isLocalRunId: localRunIds.has.bind(localRunIds),
    clearLocalRunIds: localRunIds.clear.bind(localRunIds),
    forgetLocalBtwRunId: localBtwRunIds.delete.bind(localBtwRunIds),
    isLocalBtwRunId: localBtwRunIds.has.bind(localBtwRunIds),
    clearLocalBtwRunIds: localBtwRunIds.clear.bind(localBtwRunIds),
  };
  const rawHandlers = createEventHandlers({
    ...context,
    localMode,
    refreshSessionInfo,
    streamingWatchdogMs,
  });
  onTestFinished(rawHandlers.dispose);
  const handlers = {
    ...rawHandlers,
    handleChatEvent: (event: ChatEventOverrides) =>
      rawHandlers.handleChatEvent(makeChatEvent(state, event)),
    handleAgentEvent: (event: Partial<AgentEvent>) =>
      rawHandlers.handleAgentEvent(makeAgentEvent(event)),
    handleSessionsChangedEvent: (event: Partial<SessionChangedEvent> = {}) =>
      rawHandlers.handleSessionsChangedEvent({ sessionKey: state.currentSessionKey, ...event }),
    handleSessionMessageEvent: (event: Partial<SessionMessageEvent> = {}) =>
      rawHandlers.handleSessionMessageEvent({ sessionKey: state.currentSessionKey, ...event }),
  };
  const { chatLog: log, setActivityStatus: status, tui, ...rest } = context;
  return {
    ...rest,
    ...handlers,
    log,
    status,
    programStates,
    render: tui.requestRender,
    runId: overrides.activeChatRunId ?? "run-1",
    text: (runId: string, text: string, phase: ChatEvent["state"] = "delta") =>
      handlers.handleChatEvent(textEvent(runId, text, phase)),
    chat: (runId: string, event: Omit<ChatEventOverrides, "runId"> = {}) =>
      handlers.handleChatEvent({ runId, ...event }),
    agent: (
      runId: string,
      data: AgentEvent["data"] = { phase: "start" },
      event: Omit<Partial<AgentEvent>, "runId" | "data"> = {},
    ) => handlers.handleAgentEvent({ runId, data, ...event }),
  };
};
