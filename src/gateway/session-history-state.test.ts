import { describe, expect, test, vi } from "vitest";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";
import * as sessionUtils from "./session-utils.js";

function historyText(rawMessages: unknown[]): string[] {
  return buildSessionHistorySnapshot({ rawMessages }).history.messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  });
}

function userTextMessage(text: string): Record<string, unknown> {
  return {
    role: "user",
    content: [{ type: "text", text }],
    __openclaw: { seq: 1 },
  };
}

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

  test("strips legacy internal envelopes before exposing history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "secret runtime context",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
                "",
                "visible ask",
              ].join("\n"),
            },
          ],
          __openclaw: { seq: 1 },
        },
      ],
    });

    expect(snapshot.history.messages).toHaveLength(1);
    expect(
      (
        snapshot.history.messages[0] as {
          content?: Array<{ text?: string }>;
        }
      ).content?.[0]?.text,
    ).toBe("visible ask");
  });

  test.each([
    [
      "pre-compaction memory flush prompt",
      [
        "Pre-compaction memory flush. Store durable memories only in memory/2026-04-24.md (create memory/ if needed).",
        "Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.",
        "If memory/2026-04-24.md already exists, APPEND new content only and do not overwrite existing entries.",
        "Do NOT create timestamped variant files (e.g., 2026-04-24-HHMM.md); always use the canonical 2026-04-24.md filename.",
        "If nothing to store, reply with NO_REPLY.",
        "Current time: Friday, April 24th, 2026 - 9:21 PM (Asia/Shanghai) / 2026-04-24 13:21 UTC",
      ].join("\n"),
    ],
    [
      "async command completion prompt",
      [
        "An async command the user already approved has completed.",
        "Do not run the command again.",
        "If the task requires more steps, continue from this result before replying to the user.",
        "Only ask the user for help if you are actually blocked.",
        "",
        "Exact completion details:",
        "Exec finished (gateway id=2b941bb5-df92-4543-832e-a0c8c61c7200, session=amber-cloud, code 0)",
        "approval_smoke_ok",
        "",
        "Continue the task if needed, then reply to the user in a helpful way.",
        "If it succeeded, share the relevant output.",
        "If it failed, explain what went wrong.",
      ].join("\n"),
    ],
    [
      "session startup prompt",
      [
        "A new session was started via /new or /reset.",
        "Execute your Session Startup sequence now - read the required files before responding to the user.",
        "Current time: Friday, April 24th, 2026 - 11:31 PM (Asia/Shanghai) / 2026-04-24 15:31 UTC",
      ].join(" "),
    ],
    [
      "quoted internal runtime context",
      [
        "“<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
        "status: completed successfully",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>”",
      ].join("\n"),
    ],
  ])("drops legacy internal-only %s history messages", (_name, text) => {
    expect(historyText([userTextMessage(text)])).toEqual([]);
  });

  test("keeps the real user body after a quoted background-task status prefix", () => {
    expect(
      historyText([
        userTextMessage(
          [
            '"System: [2026-04-24 23:36:38 GMT+8] Background task done: ACP background task (run bb424a68).',
            "",
            '[Fri 2026-04-24 23:38 GMT+8] 升级前 5 分钟 checklist"',
          ].join("\n"),
        ),
      ]),
    ).toEqual(["升级前 5 分钟 checklist"]);
  });
});
