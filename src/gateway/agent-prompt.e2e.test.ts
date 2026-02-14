import { describe, expect, it } from "vitest";
import { buildHistoryContextFromEntries } from "../auto-reply/reply/history.js";
import { buildAgentMessageFromConversationEntries } from "./agent-prompt.js";

describe("gateway agent prompt", () => {
  it("returns empty for no entries", () => {
    expect(buildAgentMessageFromConversationEntries([])).toBe("");
  });

  it("returns current body when there is no history", () => {
    expect(
      buildAgentMessageFromConversationEntries([
        { role: "user", entry: { sender: "User", body: "hi" } },
      ]),
    ).toBe("hi");
  });

  it("uses history context when there is history", () => {
    const entries = [
      { role: "assistant", entry: { sender: "Assistant", body: "prev" } },
      { role: "user", entry: { sender: "User", body: "next" } },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      entries: entries.map((e) => e.entry),
      currentMessage: "User: next",
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });

  it("prefers last tool entry over assistant for current message", () => {
    const entries = [
      { role: "user", entry: { sender: "User", body: "question" } },
      { role: "tool", entry: { sender: "Tool:x", body: "tool output" } },
      { role: "assistant", entry: { sender: "Assistant", body: "assistant text" } },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      entries: [entries[0].entry, entries[1].entry],
      currentMessage: "Tool:x: tool output",
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });
});
