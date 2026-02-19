import type { AssistantMessage } from "@mariozechner/pi-ai";

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function makeAssistantMessageFixture(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const errorText = typeof overrides.errorMessage === "string" ? overrides.errorMessage : "error";
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE,
    timestamp: 0,
    stopReason: "error",
    errorMessage: errorText,
    content: [{ type: "text", text: errorText }],
    ...overrides,
  };
}
