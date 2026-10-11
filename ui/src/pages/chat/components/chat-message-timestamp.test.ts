import { expect, it } from "vitest";
import { extractGroupMeta } from "./chat-message-timestamp.ts";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";

// One Claude CLI turn of two model calls: counters sum both, the marker keeps the last call.
const turnUsage = { input: 4, output: 89, cacheRead: 74_593, cacheWrite: 74_918 };

function contextPercent(usage: Record<string, unknown>) {
  const group = createMessageGroup(createAssistantMessage("done", { usage }), "assistant");
  return extractGroupMeta(group, 200_000)?.contextPercent;
}

it("sizes context from the marker when usage counters cover a whole turn", () => {
  const contextUsage = { state: "available", promptTokens: 74_920, totalTokens: 74_921 };
  expect(contextPercent({ ...turnUsage, contextUsage })).toBe(37);
});

it("sizes context from the usage counters without a marker", () => {
  expect(contextPercent(turnUsage)).toBe(75);
});
