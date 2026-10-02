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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function transcriptMessage(eventId: string, parentId: string | null, message: unknown) {
  return { eventId, parentId, message };
}
