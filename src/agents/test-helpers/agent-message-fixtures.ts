import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@mariozechner/pi-ai";

const ZERO_USAGE: Usage = {
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

export function castAgentMessage(message: unknown): AgentMessage {
  return message as AgentMessage;
}

export function castAgentMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

export function makeAgentUserMessage(
  overrides: Partial<UserMessage> & Pick<UserMessage, "content">,
): UserMessage {
  return {
    role: "user",
    timestamp: 0,
    ...overrides,
  };
}

export function makeAgentAssistantMessage(
  overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export function makeAgentToolResultMessage(
  overrides: Partial<ToolResultMessage> &
    Pick<ToolResultMessage, "toolCallId" | "toolName" | "content">,
): ToolResultMessage {
  const { toolCallId, toolName, content, ...rest } = overrides;
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError: false,
    timestamp: 0,
    ...rest,
  };
}
