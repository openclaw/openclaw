import { describe, expect, it } from "vitest";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

describe("prepared delivery context projection", () => {
  it.each([
    {
      name: "moves a later transient section without changing persistent policy",
      prompt: "old\n\nTurn context.\n\nPolicy.",
      context: { start: 5, text: "Turn context." },
      expected: { start: 12, text: "Turn context." },
    },
    {
      name: "keeps an earlier transient section unchanged",
      prompt: "Turn context.\n\nold\n\nPolicy.",
      context: { start: 0, text: "Turn context." },
      expected: { start: 0, text: "Turn context." },
    },
    {
      name: "invalidates stale producer bytes instead of repairing them",
      prompt: "old\n\nPolicy.",
      context: { start: 0, text: "stale" },
      expected: undefined,
    },
    {
      name: "rejects a transient span that cuts through the replacement",
      prompt: "old\n\nPolicy.",
      context: { start: 0, text: "ol" },
      expected: undefined,
    },
  ])("$name", ({ prompt, context, expected }) => {
    const owner = { extraSystemPrompt: prompt, extraSystemPromptTurnContext: context };
    const offset = prompt.indexOf("old");
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [owner],
      promptComponentByMode: { message_tool_only: "old", automatic: "new format" },
      promptComponentOffset: offset,
    });

    runtime.applyPreparedMode(owner, "automatic");

    expect(owner.extraSystemPrompt).toBe(prompt.replace("old", "new format"));
    expect(owner.extraSystemPromptTurnContext).toEqual(expected);
    expect(runtime.currentMode).toBe("automatic");
  });
});
