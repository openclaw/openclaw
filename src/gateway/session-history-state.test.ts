/**
 * Completed history snapshots and incremental SSE transitions.
 */
import { createHash } from "node:crypto";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type {
  SessionHistoryReadParams,
  SessionHistorySnapshot,
} from "../config/sessions/session-history-types.js";
import {
  assistantTextMessage,
  textContent,
  userTextMessage,
} from "./session-history-fixtures.test-support.js";
import { SessionHistorySseState } from "./session-history-state.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

type StateOptions = Pick<SessionHistoryReadParams, "maxChars" | "limit" | "cursor"> &
  Partial<
    Pick<
      SessionHistorySnapshot,
      "rawTranscriptSeq" | "turnBoundaryPending" | "assistantErrorPending"
    >
  >;

function newState(
  messages: SessionHistorySnapshot["history"]["messages"],
  options: StateOptions = {},
) {
  return SessionHistorySseState.fromSnapshot({
    target: { sessionId: "sess-main", sessionKey: "agent:main:main" },
    maxChars: options.maxChars,
    limit: options.limit,
    cursor: options.cursor,
    snapshot: {
      history: { items: messages, messages, hasMore: false },
      rawTranscriptSeq: options.rawTranscriptSeq ?? messages.at(-1)?.["__openclaw"]?.seq ?? 0,
      turnBoundaryPending: options.turnBoundaryPending ?? false,
      assistantErrorPending: options.assistantErrorPending ?? false,
    },
  });
}

function newStateWithUserText(text: string): SessionHistorySseState {
  return newState([userTextMessage(text, 1)]);
}

function appendAssistantText(state: SessionHistorySseState, text: string, messageSeq?: number) {
  return state.appendInlineMessage({
    message: {
      role: "assistant",
      content: textContent(text),
    },
    ...(messageSeq === undefined ? {} : { messageSeq }),
  });
}

describe("SessionHistorySseState", () => {
  test.each([undefined, 512])(
    "preserves the failed-turn cap in SSE with maxChars=%s",
    (maxChars) => {
      const state = newState([], { maxChars });
      const content = `This turn ended before a reply: Worker setup failed\n${"  at prepareWorkspace (worker.ts:42)\n".repeat(260)}Cause: network allocation failed`;
      const appended = state.appendInlineMessage({
        message: {
          role: "custom",
          customType: "run-failed-before-reply",
          content,
          details: { runId: "failed-run", error: "PRIVATE_DIAGNOSTIC" },
        },
        messageId: "failed-turn",
        messageSeq: 1,
      });
      if (maxChars === undefined) {
        expect(appended?.message?.content).toBe(content);
      } else {
        expect(String(appended?.message?.content).length).toBeLessThan(600);
        expect(appended?.message?.content).not.toContain("Cause:");
      }
      expect(appended?.message?.__openclaw).toMatchObject({ runId: "failed-run" });
      expect(appended?.message).not.toHaveProperty("details");
    },
  );

  test("seeds inline sequence from the completed snapshot watermark", () => {
    const messages = [assistantTextMessage("fresh snapshot message", 2)];
    const state = newState(messages, { rawTranscriptSeq: 4 });

    expect(state.snapshot().messages).toEqual(messages);
    expect(appendAssistantText(state, "next message")?.messageSeq).toBe(5);
  });

  test("carries inline user idempotency keys into history metadata", () => {
    const state = newState([]);

    const appended = state.appendInlineMessage({
      message: {
        role: "user",
        content: [{ type: "text", text: "optimistic turn" }],
        idempotencyKey: "client-turn-2",
      },
      messageId: "message-user-2",
      messageSeq: 2,
    });

    expect(appended).toBeDefined();
    expect(appended?.messageSeq).toBe(2);
    expect(
      (
        appended!.message as {
          __openclaw?: { id?: string; idempotencyKey?: string; seq?: number };
        }
      )["__openclaw"],
    ).toMatchObject({
      id: "message-user-2",
      idempotencyKey: "client-turn-2",
      seq: 2,
    });
  });

  test("retains the recent projection without changing carried inline sequence", () => {
    const state = newState([
      assistantTextMessage("first", 1),
      assistantTextMessage("second", 2),
      assistantTextMessage("third", 3),
      assistantTextMessage("fourth", 4),
    ]);

    const retained = state.retainRecentMessages(2);

    expect(retained.items).toBe(retained.messages);
    expect(retained.messages).toEqual([
      assistantTextMessage("third", 3),
      assistantTextMessage("fourth", 4),
    ]);
    expect(retained.hasMore).toBe(true);
    expect(retained.nextCursor).toBe("3");

    const appended = appendAssistantText(state, "fifth", 5);
    expect(appended?.messageSeq).toBe(5);
    expect(appended?.message?.content).toEqual(textContent("fifth"));
    expect(state.retainRecentMessages(2).messages).toEqual([
      assistantTextMessage("fourth", 4),
      assistantTextMessage("fifth", 5),
    ]);
  });

  test("keeps the existing projection when it already fits the retention window", () => {
    const state = newState([assistantTextMessage("first", 1)]);
    const initialSnapshot = state.snapshot();

    expect(state.retainRecentMessages(2)).toBe(initialSnapshot);
  });

  test("uses carried sequence for inline SSE appends", () => {
    const state = newState([assistantTextMessage("initial", 2)]);

    const appended = appendAssistantText(state, "carried", 9);

    expect(appended?.messageSeq).toBe(9);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(9);
  });

  test("does not emit a no-op hidden inline control reply", () => {
    const state = newStateWithUserText("reply here");

    const appended = appendAssistantText(state, "NO_REPLY", 2);

    expect(appended).toBeNull();
    expect(state.snapshot().messages).toHaveLength(1);
  });

  test("requests refresh when inline TTS supplement merges into an existing assistant message", () => {
    const visibleText = "Here is the answer.";
    const textSha256 = createHash("sha256").update(visibleText).digest("hex");
    const state = newState([assistantTextMessage(visibleText, 2)]);

    const appended = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          {
            type: "attachment",
            attachment: {
              url: "/tmp/tts.mp3",
              kind: "audio",
              label: "tts.mp3",
              mimeType: "audio/mpeg",
            },
          },
        ],
        openclawTtsSupplement: { textSha256, spokenText: visibleText },
      },
      messageSeq: 3,
    });

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toEqual([
      {
        role: "assistant",
        content: [
          textContent(visibleText)[0],
          {
            type: "attachment",
            attachment: {
              kind: "audio",
              label: "tts.mp3",
              mimeType: "audio/mpeg",
            },
          },
        ],
        __openclaw: { seq: 2 },
      },
    ]);
  });

  test("requests refresh for non-monotonic carried inline sequence", () => {
    const state = newState([assistantTextMessage("current", 5)]);

    const appended = appendAssistantText(state, "rewound branch", 3);

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toHaveLength(1);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(5);
  });

  test("requests refresh when later assistant content repairs an inline stream error", () => {
    const state = newState([userTextMessage("hello", 1)]);

    const sentinel = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: textContent(STREAM_ERROR_FALLBACK_TEXT),
        stopReason: "error",
        errorMessage: "provider failed before content",
      },
      messageSeq: 2,
    });

    expect(sentinel?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The agent run failed before producing a reply." }],
      __openclaw: { seq: 2 },
    });
    expect(appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test("keeps an inline failed turn before a new forwarded inter-session turn", () => {
    const state = newState(
      [
        {
          role: "assistant",
          content: textContent("The agent run failed before producing a reply."),
          stopReason: "error",
          __openclaw: { seq: 1 },
        },
      ],
      { assistantErrorPending: true },
    );

    const forwarded = state.appendInlineMessage({
      message: {
        role: "user",
        content: textContent("forwarded update"),
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:webchat:source",
          sourceTool: "sessions_send",
        },
      },
      messageSeq: 2,
    });

    expect(forwarded?.message).toMatchObject({
      role: "assistant",
      content: textContent("forwarded update"),
    });
    expect(appendAssistantText(state, "actual fallback response", 3)?.message).toMatchObject({
      role: "assistant",
      content: textContent("actual fallback response"),
    });
    expect(state.snapshot().messages[0]?.content).toEqual([
      { type: "text", text: "The agent run failed before producing a reply." },
    ]);
  });

  test("requests refresh when initial SSE history ends with a repaired stream error", () => {
    const state = newState(
      [
        userTextMessage("hello", 1),
        {
          role: "assistant",
          content: textContent("The agent run failed before producing a reply."),
          stopReason: "error",
          __openclaw: { seq: 2 },
        },
      ],
      { assistantErrorPending: true },
    );

    expect(appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test.each([
    { name: "latest page", cursor: undefined, expectedSeq: 8 },
    { name: "older cursor page", cursor: "8", expectedSeq: 7 },
  ])(
    "refreshes limited SSE history from bounded async reads ($name)",
    async ({ cursor, expectedSeq }) => {
      const fullReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessagesWithSourceAsync")
        .mockResolvedValue({ messages: [] });
      const tailReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
        .mockResolvedValueOnce({
          messages: [assistantTextMessage("tail two", expectedSeq)],
          totalMessages: 8,
        });
      const pageReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessagesPageWithStatsAsync")
        .mockResolvedValueOnce({
          messages: [assistantTextMessage("tail two", expectedSeq)],
          totalMessages: 8,
        });
      try {
        const state = newState([assistantTextMessage("tail one", 7)], {
          rawTranscriptSeq: 7,
          limit: 1,
          cursor,
        });

        expect(state.snapshot().messages[0]?.["__openclaw"]?.seq).toBe(7);
        const refreshed = await state.refreshAsync();

        expect(refreshed.hasMore).toBe(true);
        expect(refreshed.nextCursor).toBe(String(expectedSeq));
        expect(refreshed.messages[0]?.["__openclaw"]?.seq).toBe(expectedSeq);
        expect(tailReadSpy).toHaveBeenCalledTimes(cursor ? 0 : 1);
        expect(pageReadSpy).toHaveBeenCalledTimes(cursor ? 1 : 0);
        expect(fullReadSpy).not.toHaveBeenCalled();
      } finally {
        fullReadSpy.mockRestore();
        tailReadSpy.mockRestore();
        pageReadSpy.mockRestore();
      }
    },
  );

  test("carries a hidden heartbeat boundary into the next visible SSE append", () => {
    const state = newState([assistantTextMessage("already visible", 1)], {
      rawTranscriptSeq: 2,
      turnBoundaryPending: true,
    });

    expect(appendAssistantText(state, "HEARTBEAT_OK", 3)).toBeNull();

    const compaction = state.appendInlineMessage({
      message: {
        role: "system",
        content: textContent("Compaction summary"),
      },
      messageSeq: 4,
    });
    expect(compaction?.message?.["__openclaw"]?.turnBoundary).toBeUndefined();

    const appended = appendAssistantText(state, "Disk usage crossed 95 percent.", 5);
    expect(appended?.message).toMatchObject({
      role: "assistant",
      __openclaw: { seq: 5, turnBoundary: true },
    });
  });

  test("does not append heartbeat or internal-only SSE messages", () => {
    const state = newState([assistantTextMessage("already visible", 1)]);

    expect(
      state.appendInlineMessage({
        message: {
          role: "user",
          content: HEARTBEAT_PROMPT,
        },
      }),
    ).toBeNull();
    expect(appendAssistantText(state, "HEARTBEAT_OK")).toBeNull();
    expect(
      state.appendInlineMessage({
        message: {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "secret runtime context",
          display: false,
        },
      }),
    ).toBeNull();
    expect(
      state.appendInlineMessage({
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "runtime details",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          ],
        },
      }),
    ).toBeNull();
    expect(state.snapshot().messages).toHaveLength(1);
  });
});
