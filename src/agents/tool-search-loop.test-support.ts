import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

export const toolSearchTestModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

export function singleToolCallStreamFn(toolCall: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}): StreamFn {
  const turns: AssistantMessage["content"][] = [
    [{ type: "toolCall", ...toolCall }],
    [{ type: "text", text: "done" }],
  ];
  let turn = 0;
  return () => {
    const content = turns[turn++];
    if (!content) {
      throw new Error("unexpected extra model turn");
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage & { stopReason: "toolUse" | "stop" } = {
        role: "assistant",
        content,
        api: toolSearchTestModel.api,
        provider: toolSearchTestModel.provider,
        model: toolSearchTestModel.id,
        usage: createZeroUsageFixture(),
        timestamp: 1,
        stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
      };
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
}
