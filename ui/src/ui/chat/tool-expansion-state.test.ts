import { afterEach, describe, expect, it } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import {
  getExpandedToolCards,
  markToolCardManuallyToggled,
  resetToolExpansionStateForTest,
  syncToolCardExpansionState,
} from "./tool-expansion-state.ts";

afterEach(() => {
  resetToolExpansionStateForTest();
});

function toolCallContent(name: string, id: string) {
  return { type: "toolcall", id, name, arguments: { q: id } };
}

function createGroup(message: unknown, key = "assistant-1"): MessageGroup {
  return {
    kind: "group",
    key,
    role: "assistant",
    messages: [{ key, message }],
    timestamp: 1,
    isStreaming: false,
  };
}

describe("tool expansion state", () => {
  it("keeps only the last tool card in a turn expanded", () => {
    const group = createGroup({
      role: "assistant",
      content: [
        toolCallContent("browser.open", "call-1"),
        toolCallContent("browser.open", "call-2"),
        toolCallContent("browser.open", "call-3"),
      ],
    });

    syncToolCardExpansionState("main", [group], false);

    const expanded = getExpandedToolCards("main");
    expect(expanded.get("assistant-1:toolcard:0")).toBe(false);
    expect(expanded.get("assistant-1:toolcard:1")).toBe(false);
    expect(expanded.get("assistant-1:toolcard:2")).toBe(true);
  });

  it("ignores the auto-expand preference (last-only is always in effect)", () => {
    const group = createGroup({
      role: "assistant",
      content: [
        toolCallContent("browser.open", "call-1"),
        toolCallContent("browser.open", "call-2"),
      ],
    });

    syncToolCardExpansionState("main", [group], true);

    const expanded = getExpandedToolCards("main");
    expect(expanded.get("assistant-1:toolcard:0")).toBe(false);
    expect(expanded.get("assistant-1:toolcard:1")).toBe(true);
  });

  it("re-evaluates the expanded card as new tool results stream into the turn", () => {
    const first = createGroup({
      role: "assistant",
      content: [toolCallContent("browser.open", "call-1")],
    });
    syncToolCardExpansionState("main", [first], false);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(true);

    const grown = createGroup({
      role: "assistant",
      content: [
        toolCallContent("browser.open", "call-1"),
        toolCallContent("browser.open", "call-2"),
      ],
    });
    syncToolCardExpansionState("main", [grown], false);

    const expanded = getExpandedToolCards("main");
    expect(expanded.get("assistant-1:toolcard:0")).toBe(false);
    expect(expanded.get("assistant-1:toolcard:1")).toBe(true);
  });

  it("leaves manually toggled cards alone", () => {
    const group = createGroup({
      role: "assistant",
      content: [
        toolCallContent("browser.open", "call-1"),
        toolCallContent("browser.open", "call-2"),
      ],
    });

    syncToolCardExpansionState("main", [group], false);
    // User opens the earlier card by hand.
    getExpandedToolCards("main").set("assistant-1:toolcard:0", true);
    markToolCardManuallyToggled("main", "assistant-1:toolcard:0");

    syncToolCardExpansionState("main", [group], false);

    const expanded = getExpandedToolCards("main");
    expect(expanded.get("assistant-1:toolcard:0")).toBe(true);
    expect(expanded.get("assistant-1:toolcard:1")).toBe(true);
  });
});
