// Provides typed dependency fixtures for TUI session-action tests.
import { TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";
import { createSessionActions } from "./tui-session-actions.js";
import type { TuiStateAccess } from "./tui-types.js";

type TuiSessionList = Awaited<ReturnType<TuiBackend["listSessions"]>>;

export function makeTuiSessionList(overrides: Partial<TuiSessionList> = {}): TuiSessionList {
  const sessions = overrides.sessions ?? [];
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: {},
    ...overrides,
    sessions,
  };
}

export function makeTuiSessionDescription(
  overrides: Partial<Awaited<ReturnType<TuiBackend["describeSession"]>>> = {},
): Awaited<ReturnType<TuiBackend["describeSession"]>> {
  return { session: null, defaults: {}, ...overrides };
}

/** Creates a complete backend fixture while keeping scenario overrides type-checked. */
export function makeTuiBackend(overrides: Partial<TuiBackend> = {}): TuiBackend {
  const backend: TuiBackend = {
    connection: { url: "ws://test.invalid" },
    start: vi.fn<TuiBackend["start"]>(),
    stop: vi.fn<TuiBackend["stop"]>(),
    sendChat: vi.fn<TuiBackend["sendChat"]>(async () => ({ runId: "test-run" })),
    abortChat: vi.fn<TuiBackend["abortChat"]>(async () => ({ ok: true, aborted: false })),
    loadHistory: vi.fn<TuiBackend["loadHistory"]>(async () => ({ messages: [] })),
    describeSession: vi.fn<TuiBackend["describeSession"]>(async () => makeTuiSessionDescription()),
    listSessions: vi.fn<TuiBackend["listSessions"]>(async () => ({
      ts: 0,
      path: "",
      count: 0,
      defaults: {},
      sessions: [],
    })),
    listAgents: vi.fn<TuiBackend["listAgents"]>(async () => ({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "global",
      agents: [],
    })),
    patchSession: vi.fn<TuiBackend["patchSession"]>(async () => ({
      ok: true,
      path: "",
      key: "agent:main:main",
      entry: {},
    })),
    createSession: vi.fn<TuiBackend["createSession"]>(async () => ({ ok: true })),
    resetSession: vi.fn<TuiBackend["resetSession"]>(async () => ({ ok: true })),
    getGatewayStatus: vi.fn<TuiBackend["getGatewayStatus"]>(async () => ({})),
    listModels: vi.fn<TuiBackend["listModels"]>(async () => []),
  };
  return { ...backend, ...overrides };
}

/** Creates a real chat log with optional typed method spies. */
export function makeChatLog(): ChatLog;
export function makeChatLog<T extends Partial<ChatLog>>(overrides: T): ChatLog & T;
export function makeChatLog(overrides: Partial<ChatLog> = {}): ChatLog {
  return Object.assign(new ChatLog(), overrides);
}

/** Creates a real TUI backed by an inert terminal and a render spy. */
export function makeTui(overrides: Partial<TUI> = {}): TUI {
  const terminal = {
    start: vi.fn(),
    stop: vi.fn(),
    drainInput: vi.fn(async () => {}),
    write: vi.fn(),
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
  } satisfies ConstructorParameters<typeof TuiMainScreen>[0];
  const tui = new TuiMainScreen(terminal);
  return Object.assign(tui, { requestRender: vi.fn(), ...overrides });
}

export const createBaseState = (overrides: Partial<TuiStateAccess> = {}): TuiStateAccess => ({
  agentDefaultId: "main",
  sessionMainKey: "agent:main:main",
  sessionScope: "global",
  agents: [],
  currentAgentId: "main",
  currentSessionKey: "agent:main:main",
  currentSessionId: null,
  activeChatRunId: null,
  pendingSubmit: null,
  historyLoaded: false,
  sessionInfo: {},
  initialSessionApplied: true,
  isConnected: true,
  autoMessageSent: false,
  toolsExpanded: false,
  showThinking: false,
  connectionStatus: "connected",
  activityStatus: "idle",
  statusTimeout: null,
  lastCtrlCAt: 0,
  ...overrides,
});

export const createTestSessionActions = (
  overrides: Partial<Parameters<typeof createSessionActions>[0]>,
) =>
  createSessionActions({
    client: makeTuiBackend({ listSessions: vi.fn() }),
    chatLog: makeChatLog({
      addSystem: vi.fn(),
      addUser: vi.fn(),
      addLiveUser: vi.fn(),
      addPendingUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
    }),
    btw: { clear: vi.fn() },
    tui: makeTui(),
    opts: {},
    state: createBaseState(),
    agentNames: new Map(),
    initialSessionInput: "",
    initialSessionAgentId: null,
    resolveSessionSelection: vi.fn((raw?: string) => ({
      key: raw ?? "agent:main:main",
      agentId: "main",
    })),
    updateHeader: vi.fn(),
    updateFooter: vi.fn(),
    updateAutocompleteProvider: vi.fn(),
    setActivityStatus: vi.fn(),
    ...overrides,
  });
