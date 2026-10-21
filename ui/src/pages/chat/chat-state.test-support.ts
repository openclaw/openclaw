import { vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { buildChatItems } from "./chat-thread-build.ts";

export function emitGatewayEvent(
  state: ChatPageHost,
  event: Parameters<typeof handlePageGatewayEvent>[1]["event"],
  payload: Parameters<typeof handlePageGatewayEvent>[1]["payload"],
) {
  handlePageGatewayEvent(state, { type: "event", event, payload });
}

export function createSessionEventState(overrides: Partial<ChatPageHost> = {}) {
  const request = vi.fn().mockResolvedValue({
    messages: [],
    sessionId: "selected-session",
    thinkingLevel: null,
  });
  const host = makeChatHost({
    client: createTestGatewayClient(request),
    connectionEpoch: 1,
    sessionKey: "agent:main:main",
    ...overrides,
  });
  if (!overrides.sessions) {
    vi.spyOn(host.sessions, "refresh").mockResolvedValue(undefined);
    vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
  }
  const state = {
    ...host,
    currentSessionId: "selected-session",
    chatMessagesBySession: new Map(),
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    ...overrides,
  } as unknown as ChatPageHost;
  return { request, state };
}

export function renderedTranscript(state: ChatPageHost) {
  return buildChatItems({
    paneId: "test",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    queue: state.chatQueue,
    showToolCalls: true,
  }).flatMap((item) => {
    if (item.kind === "group") {
      return item.messages.map(({ message }) => ({
        role: item.role,
        text: extractText(message),
      }));
    }
    return item.kind === "stream" ? [{ role: "assistant", text: item.text }] : [];
  });
}
