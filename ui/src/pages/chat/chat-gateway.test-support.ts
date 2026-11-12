import { onTestFinished, vi } from "vitest";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";

export function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatRunStartup: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

export function createHistoryStateForClient(
  client: NonNullable<ChatState["client"]>,
  overrides: Partial<ChatHistoryHost> = {},
): ChatHistoryHost {
  const state = createState({ client, ...overrides });
  if (overrides.sessions) {
    return { ...state, sessions: overrides.sessions };
  }
  const sessions = createTestSessionCapability({
    snapshot: {
      client: state.client,
      phase: state.connected ? "connected" : "reconnecting",
      hello: state.hello,
      sessionKey: state.sessionKey,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => sessions.dispose());
  return { ...state, sessions };
}
