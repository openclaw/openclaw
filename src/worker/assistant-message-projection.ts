import type { AssistantMessage, Usage } from "../llm/types.js";

// Provider adapters retain scratch fields; outbound messages use the closed worker schema.
export function projectWorkerAssistantContent(part: AssistantMessage["content"][number]) {
  if (part.type === "text") {
    return {
      type: "text" as const,
      text: part.text,
      ...(part.textSignature ? { textSignature: part.textSignature } : {}),
    };
  }
  if (part.type === "thinking") {
    return {
      type: "thinking" as const,
      thinking: part.thinking,
      ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
      ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
    };
  }
  return {
    type: "toolCall" as const,
    id: part.id,
    name: part.name,
    arguments: structuredClone(part.arguments),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    ...(part.executionMode ? { executionMode: part.executionMode } : {}),
  };
}

export function projectWorkerTokenUsage(usage: Usage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
      ...(usage.cost.totalOrigin ? { totalOrigin: usage.cost.totalOrigin } : {}),
    },
  };
}
