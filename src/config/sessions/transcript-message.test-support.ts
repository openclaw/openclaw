import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { appendExactAssistantMessageToSessionTranscript } from "./transcript.js";

export type ExactAssistantMessage = Parameters<
  typeof appendExactAssistantMessageToSessionTranscript
>[0]["message"];

export function createExactAssistantMessage(params: {
  text?: string;
  content?: ExactAssistantMessage["content"];
  provider?: string;
  model?: string;
}): ExactAssistantMessage {
  return {
    role: "assistant",
    content: params.content ?? [{ type: "text", text: params.text ?? "" }],
    api: "openai-responses",
    provider: params.provider ?? "codex",
    model: params.model ?? "gpt-5.4",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function messageEvent<Message, Parent>(id: string, parentId: Parent, message: Message) {
  return { type: "message", id, parentId, message };
}

export function timedMessageEvent<Message, Parent, Timestamp>(
  id: string,
  parentId: Parent,
  timestamp: Timestamp,
  message: Message,
) {
  return { type: "message", id, parentId, timestamp, message };
}

export function transcriptMessage(eventId: string, parentId: string | null, message: unknown) {
  return { eventId, parentId, message };
}

export function createManualCompactRecords(sessionId: string, cwd?: string) {
  return [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-19T12:00:00.000Z",
      ...(cwd ? { cwd } : {}),
    },
    ...[1, 2, 3, 4].map((index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 1 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:0${index}.000Z`,
      message: { role: "user", content: `message ${index}`, timestamp: index },
    })),
  ];
}
