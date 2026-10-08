import { createStreamingTextExtractor } from "../../lib/chat/message-extract.ts";
import type { ChatEventPayload } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";

type StreamProjection = {
  client: ChatState["client"];
  epoch: number;
  sessionKey: string;
  sessionId: ChatState["currentSessionId"];
  agentId: ChatEventPayload["agentId"];
  runId: ChatEventPayload["runId"];
  text: string | null;
  extract: ReturnType<typeof createStreamingTextExtractor>;
};

const streams = new WeakMap<ChatState, StreamProjection>();

export function extractChatStreamText(state: ChatState, payload: ChatEventPayload): string | null {
  let stream = streams.get(state);
  if (
    !stream ||
    stream.client !== state.client ||
    stream.epoch !== state.connectionEpoch ||
    stream.sessionKey !== state.sessionKey ||
    stream.sessionId !== state.currentSessionId ||
    stream.agentId !== payload.agentId ||
    stream.runId !== payload.runId ||
    stream.text !== state.chatStream
  ) {
    stream = {
      client: state.client,
      epoch: state.connectionEpoch,
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId,
      agentId: payload.agentId,
      runId: payload.runId,
      text: state.chatStream,
      extract: createStreamingTextExtractor(),
    };
    streams.set(state, stream);
  }
  // Wire reconstruction belongs to the connection. An absent snapshot supplies no text.
  stream.text = payload.message == null ? null : (stream.extract(payload.message) ?? "");
  return stream.text;
}

export function retireChatStreamProjection(state: ChatState): void {
  streams.delete(state);
}
