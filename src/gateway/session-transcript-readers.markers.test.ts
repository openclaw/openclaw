import { describe, expect, test } from "vitest";
import { createResetBoundaryTranscriptSource } from "./session-end-transcript-reader.js";
import { useTranscriptFixture } from "./session-transcript-fixtures.test-support.js";
import {
  readRecentSessionMessagesWithStatsAsync as readRecent,
  readSessionMessageByIdAsync as readById,
  readSessionMessageCountAsync as readCount,
  readSessionMessagesAsync as readFull,
  readSessionMessagesAroundIdWithStatsAsync as readAround,
  readSessionMessagesMatchingIdAsync as readMatching,
  readSessionMessagesPageWithStatsAsync as readPage,
} from "./session-transcript-readers.js";

const timestamp = "2026-08-11T18:00:00.000Z";

function message(id: string, role: "user" | "assistant" | "toolResult" = "user") {
  return { type: "message" as const, id, message: { role, content: id } };
}

function compaction(id: string, firstKeptEntryId: string) {
  return {
    type: "compaction" as const,
    id,
    timestamp,
    summary: `${id} summary`,
    firstKeptEntryId,
    tokensBefore: 100,
    tokensAfter: 25,
  };
}

function reset(id: string, firstKeptEntryId?: string) {
  return { type: "reset" as const, id, timestamp, reason: "reset", firstKeptEntryId };
}

function customMessage(id: string, display: unknown, customType = "run-failed-before-reply") {
  return {
    type: "custom_message" as const,
    id,
    timestamp,
    customType,
    content: `${id}: This turn ended before a reply.`,
    display,
    details: { error: "private diagnostic" },
  };
}

type Event = ReturnType<typeof message | typeof compaction | typeof reset | typeof customMessage>;
type Scenario = [name: string, events: Event[], visible: string, hidden?: string];
const ids = (text: string) => text.split(" ");

function messageIds(messages: unknown[]) {
  return messages.map((entry) => (entry as { __openclaw: { id: string } })["__openclaw"].id);
}

describe("session transcript reader marker projection", () => {
  const fixture = useTranscriptFixture("openclaw-transcript-markers-");
  const writeTranscript = (sessionId: string, events: Array<{ id: string }>) =>
    fixture.writeTranscript(
      sessionId,
      events.map((event, index) => ({
        ...event,
        parentId: events[index - 1]?.id ?? null,
      })),
    );

  test("reads a bounded ended window without successor turns after same-ID reset", async () => {
    const boundaryId = "ended-boundary";
    const scope = await writeTranscript("ended-window", [
      message("prior-user"),
      message("prior-assistant", "assistant"),
      reset(boundaryId),
      message("successor-user"),
    ]);
    const source = createResetBoundaryTranscriptSource(scope, boundaryId);
    if (!source.available) {
      throw new Error("expected available ended transcript source");
    }

    const result = await source.readTail({ maxMessages: 10, maxBytes: 2_048 });

    expect(messageIds([...result.messages])).toEqual(["prior-user", "prior-assistant"]);
    expect(result).toMatchObject({ totalMessages: 2, truncated: false });
  });

  test.each<Scenario>([
    [
      "displayed-custom-messages",
      [
        message("user"),
        customMessage("notice", true),
        customMessage("hidden", false),
        customMessage("missing-display", undefined),
        customMessage("numeric-display", 1),
        customMessage("string-display", "true"),
        customMessage("runtime-context", true, "openclaw.runtime-context"),
        compaction("summary", "user"),
        customMessage("after-summary", true),
      ],
      "user notice summary after-summary",
      "hidden missing-display numeric-display string-display runtime-context",
    ],
    [
      "kept-reset-adjacent-compactions",
      [
        message("old"),
        customMessage("old-notice", true),
        compaction("old-summary", "old"),
        message("kept-user"),
        message("orphan-tool", "toolResult"),
        message("kept-assistant", "assistant"),
        reset("reset", "kept-user"),
        compaction("fresh-summary", "kept-user"),
        compaction("newest-summary", "kept-user"),
      ],
      "kept-user kept-assistant reset fresh-summary newest-summary",
    ],
  ])("projects %s boundaries through SQLite history", async (name, events, visible, hidden) => {
    const expectedIds = ids(visible);
    const hiddenIds = hidden ? ids(hidden) : [];
    const scope = await writeTranscript(`reader-${name}`, events);
    const full = await readFull(scope, {
      mode: "full",
      reason: `${name} boundary projection test`,
    });
    const recent = await readRecent(scope, {
      maxBytes: 16_384,
      maxLines: 2,
      maxMessages: 2,
    });

    expect(messageIds(full)).toEqual(expectedIds);
    expect(messageIds(recent.messages)).toEqual(expectedIds.slice(-2));
    expect(recent.totalMessages).toBe(expectedIds.length);
    expect(await readCount(scope)).toBe(expectedIds.length);
    for (const entry of events) {
      const { id } = entry;
      const index = expectedIds.indexOf(id);
      const byId = await readById(scope, id);
      expect(await readMatching(scope, id)).toEqual(index < 0 ? [] : [full[index]]);
      if (index < 0) {
        if (hiddenIds.includes(id)) {
          expect(byId).toMatchObject({ found: false });
        } else {
          expect(byId).toMatchObject({ found: true, message: { __openclaw: { id } } });
        }
        continue;
      }
      const page = await readPage(scope, {
        maxMessages: 1,
        offset: expectedIds.length - index - 1,
      });
      expect(messageIds(page.messages)).toEqual([id]);
      expect(page.totalMessages).toBe(expectedIds.length);
      expect(byId).toMatchObject({
        found: true,
        seq: index + 1,
        message: { __openclaw: { id, seq: index + 1 } },
      });
      if (entry.type === "compaction") {
        expect(full[index]).toMatchObject({
          __openclaw: { tokensBefore: 100, tokensAfter: 25 },
        });
      }
    }
    const anchored = await readAround(scope, { messageId: expectedIds[0]!, maxMessages: 10 });
    expect(anchored).toMatchObject({ found: true, totalMessages: expectedIds.length });
    expect(messageIds(anchored.messages)).toEqual(expectedIds);
  });
});
