import { describe, expect, test, vi } from "vitest";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";
import * as sessionUtils from "./session-utils.js";

describe("SessionHistorySseState", () => {
  test("uses the initial raw snapshot for both first history and seq seeding", () => {
    const readSpy = vi.spyOn(sessionUtils, "readSessionMessages").mockReturnValue([
      {
        role: "assistant",
        content: [{ type: "text", text: "stale disk message" }],
        __openclaw: { seq: 1 },
      },
    ]);
    try {
      const state = SessionHistorySseState.fromRawSnapshot({
        target: { sessionId: "sess-main" },
        rawMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "fresh snapshot message" }],
            __openclaw: { seq: 2 },
          },
        ],
      });

      expect(state.snapshot().messages).toHaveLength(1);
      expect(
        (
          state.snapshot().messages[0] as {
            content?: Array<{ text?: string }>;
            __openclaw?: { seq?: number };
          }
        ).content?.[0]?.text,
      ).toBe("fresh snapshot message");
      expect(
        (
          state.snapshot().messages[0] as {
            __openclaw?: { seq?: number };
          }
        ).__openclaw?.seq,
      ).toBe(2);

      const appended = state.appendInlineMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "next message" }],
        },
      });

      expect(appended?.messageSeq).toBe(3);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test("reuses one canonical array for items and messages", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          __openclaw: { seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          __openclaw: { seq: 2 },
        },
      ],
      limit: 1,
    });

    expect(snapshot.history.items).toBe(snapshot.history.messages);
    expect(snapshot.history.messages[0]?.__openclaw?.seq).toBe(2);
    expect(snapshot.rawTranscriptSeq).toBe(2);
  });

  test("strips leading system-event prompt prefixes from user history snapshots", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content:
            "System (untrusted): [Mon 2026-04-13 09:30:01 EDT] Exec completed (abc12345, code 0) :: npm test\n" +
            "System (untrusted): stdout: all green\n\n" +
            "Please summarize",
          __openclaw: { seq: 1 },
        },
      ],
    });

    expect(snapshot.history.messages).toHaveLength(1);
    expect(snapshot.history.messages[0]?.content).toBe("Please summarize");
  });

  test("strips leading system-event prompt prefixes from inline SSE updates", () => {
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "sess-main" },
      rawMessages: [],
    });

    const appended = state.appendInlineMessage({
      message: {
        role: "user",
        content:
          "System (untrusted): [Mon 2026-04-13 09:30:01 EDT] Exec completed (abc12345, code 0) :: npm test\n" +
          "System (untrusted): stdout: all green\n\n" +
          "What changed?",
      },
      messageId: "msg-1",
    });

    expect(appended).not.toBeNull();
    expect((appended?.message as { content?: string }).content).toBe("What changed?");
    expect((state.snapshot().messages[0] as { content?: string }).content).toBe("What changed?");
  });
});
