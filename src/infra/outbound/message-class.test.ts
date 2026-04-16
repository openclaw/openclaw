import { describe, expect, it } from "vitest";
import { classifyMessageClass, type ClassificationSignal } from "./message-class.js";

describe("classifyMessageClass", () => {
  describe("boot_session source", () => {
    it("classifies boot-prefixed session keys as boot", () => {
      expect(
        classifyMessageClass({
          source: "boot_session",
          sessionKey: "boot-abc123",
        }),
      ).toBe("boot");
    });

    it("classifies boot:-prefixed session keys as boot", () => {
      expect(
        classifyMessageClass({
          source: "boot_session",
          sessionKey: "boot:legacy",
        }),
      ).toBe("boot");
    });

    it("falls back to internal_narration when session key lacks boot prefix", () => {
      expect(
        classifyMessageClass({
          source: "boot_session",
          sessionKey: "agent:main:main",
        }),
      ).toBe("internal_narration");
    });
  });

  describe("acp_stream source", () => {
    it("classifies assistant stream as final_reply", () => {
      expect(
        classifyMessageClass({
          source: "acp_stream",
          stream: "assistant",
          text: "Done.",
        }),
      ).toBe("final_reply");
    });

    it("classifies lifecycle stream as progress", () => {
      expect(
        classifyMessageClass({
          source: "acp_stream",
          stream: "lifecycle",
          text: "Started",
        }),
      ).toBe("progress");
    });

    it("defaults unknown streams to internal_narration (safe default)", () => {
      expect(
        classifyMessageClass({
          source: "acp_stream",
          stream: "some_random_new_stream",
          text: "anything",
        }),
      ).toBe("internal_narration");
    });

    it("promotes to blocked when text contains a blocked heuristic", () => {
      expect(
        classifyMessageClass({
          source: "acp_stream",
          stream: "assistant",
          text: "I'm blocked and need your input on this.",
        }),
      ).toBe("blocked");
    });
  });

  describe("codex_event source", () => {
    it("classifies assistant_message items as final_reply", () => {
      expect(
        classifyMessageClass({
          source: "codex_event",
          eventType: "codex_app_server.item",
          itemType: "assistant_message",
          text: "Reply text",
        }),
      ).toBe("final_reply");
    });

    it("classifies other codex item types as internal_narration", () => {
      expect(
        classifyMessageClass({
          source: "codex_event",
          eventType: "codex_app_server.item",
          itemType: "tool_call",
        }),
      ).toBe("internal_narration");
    });

    it("classifies non-item codex events as internal_narration", () => {
      expect(
        classifyMessageClass({
          source: "codex_event",
          eventType: "codex_app_server.session_started",
        }),
      ).toBe("internal_narration");
    });

    it("promotes assistant_message to blocked when text asks for input", () => {
      expect(
        classifyMessageClass({
          source: "codex_event",
          eventType: "codex_app_server.item",
          itemType: "assistant_message",
          text: "Should I proceed with option A or option B?",
        }),
      ).toBe("blocked");
    });
  });

  describe("task_terminal source", () => {
    it("classifies blocked-outcome tasks as blocked", () => {
      expect(
        classifyMessageClass({
          source: "task_terminal",
          text: "Task blocked",
          terminal: "blocked",
        }),
      ).toBe("blocked");
    });

    it("classifies non-blocked terminal tasks as completion", () => {
      expect(
        classifyMessageClass({
          source: "task_terminal",
          text: "Task succeeded",
          terminal: "succeeded",
        }),
      ).toBe("completion");
      expect(
        classifyMessageClass({
          source: "task_terminal",
          text: "Task failed",
          terminal: "failed",
        }),
      ).toBe("completion");
    });
  });

  describe("task_progress source", () => {
    it("classifies task progress as progress", () => {
      expect(
        classifyMessageClass({
          source: "task_progress",
          text: "Working on step 2",
        }),
      ).toBe("progress");
    });

    it("escalates to blocked when progress text asks for input", () => {
      expect(
        classifyMessageClass({
          source: "task_progress",
          text: "Waiting on approval before I continue",
        }),
      ).toBe("blocked");
    });
  });

  describe("heartbeat_drain source", () => {
    it("preserves an originally classified message class", () => {
      expect(
        classifyMessageClass({
          source: "heartbeat_drain",
          originalClass: "final_reply",
          text: "some text",
        }),
      ).toBe("final_reply");
    });

    it("defaults to internal_narration when no original class is supplied", () => {
      expect(
        classifyMessageClass({
          source: "heartbeat_drain",
          text: "unknown",
        }),
      ).toBe("internal_narration");
    });
  });

  describe("unclassified source", () => {
    it("defaults to internal_narration", () => {
      expect(
        classifyMessageClass({
          source: "unclassified",
          text: "some stray log line",
        }),
      ).toBe("internal_narration");
    });

    it("escalates to blocked when blocked heuristic matches", () => {
      expect(
        classifyMessageClass({
          source: "unclassified",
          text: "I am blocked without approval",
        }),
      ).toBe("blocked");
    });
  });

  it("exhaustively handles every declared source branch", () => {
    // Compile-time exhaustiveness check: if a new source is added to
    // ClassificationSignal without a classifier case, TypeScript will fail.
    const signals: ClassificationSignal[] = [
      { source: "acp_stream", stream: "assistant" },
      { source: "codex_event", eventType: "foo" },
      { source: "boot_session", sessionKey: "boot-x" },
      { source: "task_terminal", text: "done", terminal: "succeeded" },
      { source: "task_progress", text: "update" },
      { source: "heartbeat_drain" },
      { source: "unclassified", text: "x" },
    ];
    for (const s of signals) {
      // Should never throw on valid input.
      expect(() => classifyMessageClass(s)).not.toThrow();
    }
  });
});
