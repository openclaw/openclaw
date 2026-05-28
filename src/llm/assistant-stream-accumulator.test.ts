import { describe, expect, it } from "vitest";
import { createAssistantStreamAccumulator } from "./assistant-stream-accumulator.js";
import type { AssistantMessage } from "./types.js";

const model = {
  api: "test-api",
  provider: "test-provider",
  model: "test-model",
};

function expectTextContent(message: AssistantMessage, text: string): void {
  expect(message.content).toEqual([{ type: "text", text }]);
}

describe("createAssistantStreamAccumulator", () => {
  it("emits lightweight partials for dense text deltas and a full final message", () => {
    const accumulator = createAssistantStreamAccumulator({ model, timestamp: 123 });

    expect(accumulator.start().partial.content).toEqual([]);
    expect(accumulator.startText(0).partial.content).toEqual([{ type: "text", text: "" }]);

    const firstDelta = accumulator.appendTextDelta(0, "Hel");
    const secondDelta = accumulator.appendTextDelta(0, "lo");

    expect(firstDelta.delta).toBe("Hel");
    expect(firstDelta.partial.content).toEqual([]);
    expect(secondDelta.delta).toBe("lo");
    expect(secondDelta.partial.content).toEqual([]);

    const textEnd = accumulator.endText(0);
    expect(textEnd.content).toBe("Hello");
    expectTextContent(textEnd.partial, "Hello");

    const done = accumulator.done("stop");
    expectTextContent(done.message, "Hello");
    expect(done.message.timestamp).toBe(123);
  });

  it("can preserve full delta partial snapshots for compatibility streams", () => {
    const accumulator = createAssistantStreamAccumulator({
      model,
      deltaPartialMode: "snapshot",
      timestamp: 123,
    });

    accumulator.start();
    accumulator.startText(0);
    const delta = accumulator.appendTextDelta(0, "Hello");

    expectTextContent(delta.partial, "Hello");
  });

  it("marks replacement text deltas and keeps the final message converged", () => {
    const accumulator = createAssistantStreamAccumulator({ model, timestamp: 123 });

    accumulator.start();
    accumulator.startText(0);
    accumulator.appendTextDelta(0, "Final answer");
    const replacement = accumulator.appendTextDelta(0, "Final answer only.", { replace: true });

    expect(replacement.replace).toBe(true);
    expect(replacement.delta).toBe("Final answer only.");
    expect(accumulator.endText(0).content).toBe("Final answer only.");
  });

  it("accumulates thinking and tool-call boundaries without provider policy", () => {
    const accumulator = createAssistantStreamAccumulator({ model, timestamp: 123 });

    accumulator.start();
    accumulator.startThinking(0);
    const thinkingDelta = accumulator.appendThinkingDelta(0, "because");
    expect(thinkingDelta.partial.content).toEqual([]);
    expect(accumulator.endThinking(0).partial.content).toEqual([
      { type: "thinking", thinking: "because" },
    ]);

    accumulator.startToolCall(1, {
      type: "toolCall",
      id: "call-1",
      name: "lookup",
      arguments: {},
    });
    accumulator.appendToolCallDelta(1, '{"q":"hi"}', (toolCall) => {
      toolCall.arguments = { q: "hi" };
    });

    const toolEnd = accumulator.endToolCall(1);
    expect(toolEnd.toolCall).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "lookup",
      arguments: { q: "hi" },
    });
    expect(toolEnd.partial.content).toEqual([
      { type: "thinking", thinking: "because" },
      {
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        arguments: { q: "hi" },
      },
    ]);
  });
});
