// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import { reconcilePersistedAssistantStream } from "./stream-segment-pruning.ts";

function persisted(runId: string, text: string) {
  return { role: "assistant", content: text, __openclaw: { id: runId, runId, seq: 1 } };
}

function visibleText(state: ToolStreamReconciliationState) {
  return visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: () => false,
  })
    .map((part) => part.text)
    .join("");
}

describe("persisted assistant stream history cache", () => {
  it("does not revisit history on deltas and reconciles a replacement array", () => {
    const readOldRole = vi.fn(() => "user");
    const history = [
      {
        get role() {
          return readOldRole();
        },
      },
    ];
    const state: ToolStreamReconciliationState = {
      chatMessages: history,
      chatRunId: "active",
      chatStream: "Saved",
      chatStreamStartedAt: 1,
    };
    reconcilePersistedAssistantStream(state);
    expect(readOldRole).toHaveBeenCalled();
    readOldRole.mockClear();
    state.chatStream = "Saved tail";
    reconcilePersistedAssistantStream(state);
    expect(readOldRole).not.toHaveBeenCalled();
    expect(visibleText(state)).toBe("Saved tail");

    state.chatMessages = [...history, persisted("active", "Saved")];
    reconcilePersistedAssistantStream(state);
    expect(readOldRole).toHaveBeenCalled();
    expect(visibleText(state).trim()).toBe("tail");
    readOldRole.mockClear();
    state.chatStream = "Saved tail grows";
    reconcilePersistedAssistantStream(state);
    expect(readOldRole).not.toHaveBeenCalled();
    expect(visibleText(state).trim()).toBe("tail grows");
  });

  it("scopes cached history to the run and observes same-length row replacements", () => {
    const history = [persisted("first", "First"), persisted("second", "Second")];
    for (const [chatRunId, text] of [
      ["first", "First"],
      ["second", "Second"],
      ["first", "First"],
    ]) {
      const state: ToolStreamReconciliationState = {
        chatMessages: history,
        chatRunId,
        chatStream: `${text} tail`,
        chatStreamStartedAt: 1,
      };
      reconcilePersistedAssistantStream(state);
      expect(visibleText(state).trim()).toBe("tail");
      state.chatMessages = [
        persisted("first", chatRunId === "first" ? "First tail" : "First"),
        persisted("second", chatRunId === "second" ? "Second tail" : "Second"),
      ];
      reconcilePersistedAssistantStream(state);
      expect(visibleText(state)).toBe("");
    }
  });
});
