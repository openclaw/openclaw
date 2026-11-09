import { createHash } from "node:crypto";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type {
  SessionHistoryReadParams,
  SessionHistorySnapshot,
} from "../config/sessions/session-history-types.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import {
  assistantTextMessage,
  textContent,
  userTextMessage,
} from "./session-history-fixtures.test-support.js";
import { SessionHistorySseState } from "./session-history-state.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

type StateOptions = Pick<SessionHistoryReadParams, "maxChars" | "limit" | "cursor"> &
  Pick<SessionHistorySnapshot["history"], "windowReset"> &
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
      history: { items: messages, messages, hasMore: false, windowReset: options.windowReset },
      rawTranscriptSeq: options.rawTranscriptSeq ?? messages.at(-1)?.["__openclaw"]?.seq ?? 0,
      turnBoundaryPending: options.turnBoundaryPending ?? false,
      assistantErrorPending: options.assistantErrorPending ?? false,
    },
  });
}

async function appendMessage(
  state: SessionHistorySseState,
  message: unknown,
  messageSeq?: number,
  messageId?: string,
) {
  return (await state.prepareInlineMessage({ message, messageSeq, messageId }))();
}

const appendAssistantText = (state: SessionHistorySseState, text: string, seq?: number) =>
  appendMessage(state, { role: "assistant", content: textContent(text) }, seq);
const failedMessage = (seq: number) => ({
  ...assistantTextMessage("The agent run failed before producing a reply.", seq),
  stopReason: "error",
});

describe("SessionHistorySseState", () => {
  test("seeds inline sequence from the completed snapshot watermark", async () => {
    const messages = [assistantTextMessage("fresh snapshot message", 2)];
    const state = newState(messages, { rawTranscriptSeq: 4 });

    expect(state.snapshot().messages).toEqual(messages);
    expect((await appendAssistantText(state, "next message"))?.messageSeq).toBe(5);
  });

  test("carries inline user idempotency keys into history metadata", async () => {
    const state = newState([]);

    const appended = await appendMessage(
      state,
      {
        role: "user",
        content: textContent("optimistic turn"),
        idempotencyKey: "client-turn-2",
      },
      2,
      "message-user-2",
    );
    expect(appended).toBeDefined();
    expect(appended?.messageSeq).toBe(2);
    expect(appended?.message).toMatchObject({
      __openclaw: { id: "message-user-2", idempotencyKey: "client-turn-2", seq: 2 },
    });
  });

  test("retains the recent projection without changing carried inline sequence", async () => {
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

    const appended = await appendAssistantText(state, "fifth", 5);
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

  test("uses carried sequence for inline SSE appends", async () => {
    const state = newState([assistantTextMessage("initial", 2)]);

    const appended = await appendAssistantText(state, "carried", 9);

    expect(appended?.messageSeq).toBe(9);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(9);
  });

  test("requests refresh when inline TTS supplement merges into an existing assistant message", async () => {
    const visibleText = "Here is the answer.";
    const textSha256 = createHash("sha256").update(visibleText).digest("hex");
    const state = newState([assistantTextMessage(visibleText, 2)]);

    const attachment = { kind: "audio", label: "tts.mp3", mimeType: "audio/mpeg" };
    const appended = await appendMessage(
      state,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          { type: "attachment", attachment: { ...attachment, url: "/tmp/tts.mp3" } },
        ],
        openclawTtsSupplement: { textSha256, spokenText: visibleText },
      },
      3,
    );

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toEqual([
      {
        role: "assistant",
        content: [textContent(visibleText)[0], { type: "attachment", attachment }],
        __openclaw: { seq: 2 },
      },
    ]);
  });

  test("requests refresh for non-monotonic carried inline sequence", async () => {
    const state = newState([assistantTextMessage("current", 5)]);

    const appended = await appendAssistantText(state, "rewound branch", 3);

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toHaveLength(1);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(5);
  });

  test("requests refresh when later assistant content repairs an inline stream error", async () => {
    const state = newState([userTextMessage("hello", 1)]);

    const sentinel = await appendMessage(
      state,
      {
        role: "assistant",
        content: textContent(STREAM_ERROR_FALLBACK_TEXT),
        stopReason: "error",
        errorMessage: "provider failed before content",
      },
      2,
    );

    expect(sentinel?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The agent run failed before producing a reply." }],
      __openclaw: { seq: 2 },
    });
    expect(await appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test("keeps an inline failed turn before a new forwarded inter-session turn", async () => {
    const state = newState([failedMessage(1)], { assistantErrorPending: true });

    const forwarded = await appendMessage(
      state,
      {
        role: "user",
        content: textContent("forwarded update"),
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:webchat:source",
          sourceTool: "sessions_send",
        },
      },
      2,
    );

    expect(forwarded?.message).toMatchObject({
      role: "assistant",
      content: textContent("forwarded update"),
    });
    expect(
      (await appendAssistantText(state, "actual fallback response", 3))?.message,
    ).toMatchObject({
      role: "assistant",
      content: textContent("actual fallback response"),
    });
    expect(state.snapshot().messages[0]?.content).toEqual([
      { type: "text", text: "The agent run failed before producing a reply." },
    ]);
  });

  test("requests refresh when initial SSE history ends with a repaired stream error", async () => {
    const state = newState([userTextMessage("hello", 1), failedMessage(2)], {
      assistantErrorPending: true,
    });

    expect(await appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test.each([
    { name: "latest page", cursor: undefined, expectedSeq: 8, reset: undefined },
    { name: "older cursor page", cursor: "8", expectedSeq: 7, reset: undefined },
    { name: "initial reset", cursor: "8", expectedSeq: 8, reset: "initial" },
    { name: "reset during refresh", cursor: "8", expectedSeq: 8, reset: "refresh" },
  ])(
    "refreshes limited SSE history from bounded async reads ($name)",
    async ({ cursor, expectedSeq, reset }) => {
      const fullReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessagesWithSourceAsync")
        .mockResolvedValue({ messages: [] });
      const tailReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
        .mockResolvedValue({
          messages: [assistantTextMessage("tail two", expectedSeq)],
          totalMessages: 8,
        });
      const pageReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessagesPageWithStatsAsync")
        .mockResolvedValue({
          messages: [assistantTextMessage("tail two", expectedSeq)],
          totalMessages: 8,
        });
      if (reset === "refresh") {
        pageReadSpy.mockRejectedValueOnce(
          new SessionTranscriptProjectionUnavailableError("sess-main", "window-changed"),
        );
      }
      try {
        const state = newState([assistantTextMessage("tail one", 7)], {
          rawTranscriptSeq: 7,
          limit: 1,
          cursor,
          windowReset: reset === "initial",
        });

        expect(state.snapshot().messages[0]?.["__openclaw"]?.seq).toBe(7);
        const refreshed = await state.refreshAsync();

        expect(refreshed.hasMore).toBe(true);
        expect(refreshed.nextCursor).toBe(String(expectedSeq));
        expect(refreshed.messages[0]?.["__openclaw"]?.seq).toBe(expectedSeq);
        expect(tailReadSpy).toHaveBeenCalledTimes(!cursor || reset ? 1 : 0);
        expect(pageReadSpy).toHaveBeenCalledTimes(cursor && reset !== "initial" ? 1 : 0);
        if (reset) {
          tailReadSpy.mockResolvedValueOnce({
            messages: [assistantTextMessage("next tail", 9)],
            totalMessages: 9,
          });
          expect((await state.refreshAsync()).messages).toEqual([
            assistantTextMessage("next tail", 9),
          ]);
        }
        expect(fullReadSpy).not.toHaveBeenCalled();
      } finally {
        fullReadSpy.mockRestore();
        tailReadSpy.mockRestore();
        pageReadSpy.mockRestore();
      }
    },
  );

  test.each(["system", "user"] as const)(
    "carries a hidden boundary past %s only when no visible user consumes it",
    async (role) => {
      const state = newState([assistantTextMessage("already visible", 1)], {
        rawTranscriptSeq: 2,
        turnBoundaryPending: true,
      });
      if (role === "system") {
        expect(await appendAssistantText(state, "HEARTBEAT_OK", 3)).toBeNull();
      }
      const message =
        role === "system"
          ? { role, content: textContent("Compaction summary") }
          : userTextMessage("A real follow-up question", 4);
      expect(
        (await appendMessage(state, message, 4))?.message?.["__openclaw"]?.turnBoundary,
      ).toBeUndefined();
      const text =
        role === "system" ? "Disk usage crossed 95 percent." : "should I fix points 1-4?";
      const appended = await appendAssistantText(state, text, 5);
      expect(appended?.message).toMatchObject({ role: "assistant", __openclaw: { seq: 5 } });
      expect(appended?.message?.["__openclaw"]?.turnBoundary).toBe(
        role === "system" ? true : undefined,
      );
    },
  );

  test.each([userTextMessage("reply here", 1), assistantTextMessage("already visible", 1)])(
    "does not append no-op, heartbeat, or internal-only SSE messages after $role",
    async (initial) => {
      const state = newState([initial]);
      expect(await appendAssistantText(state, "NO_REPLY", 2)).toBeNull();
      expect(state.snapshot().messages).toHaveLength(1);
      for (const message of [
        { role: "user", content: HEARTBEAT_PROMPT },
        { role: "assistant", content: textContent("HEARTBEAT_OK") },
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "secret runtime context",
          display: false,
        },
        {
          role: "user",
          content: textContent(
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nruntime details\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ),
        },
      ]) {
        expect(await appendMessage(state, message)).toBeNull();
      }
      expect(state.snapshot().messages).toHaveLength(1);
    },
  );
});
