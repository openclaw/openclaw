import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createResetBoundaryTranscriptSource } from "./session-end-transcript-reader.js";
import { visitSessionMessagesAsync } from "./session-transcript-native.test-support.js";
import {
  readRecentSessionMessagesWithStatsAsync as readRecent,
  readSessionMessageByIdAsync as readById,
  readSessionMessageCountAsync as readCount,
  readSessionMessagesAsync as readFull,
  readSessionMessagesAroundIdWithStatsAsync as readAround,
  readSessionMessagesMatchingIdAsync as readMatching,
  readSessionMessagesPageWithStatsAsync as readPage,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const tempDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-transcript-markers-",
);
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
function scenario(name: string, events: Event[], expectedIds: string[], hiddenIds: string[] = []) {
  return { name, events, expectedIds, hiddenIds };
}

function messageIds(messages: unknown[]) {
  return messages.map((entry) => (entry as { __openclaw: { id: string } })["__openclaw"].id);
}

function historicalWindowIds(
  events: Array<{ id: string; type?: string }>,
  targetId: string,
  hiddenIds: string[],
) {
  const targetIndex = events.findIndex((event) => event.id === targetId);
  const closingIndex =
    events[targetIndex]?.type === "reset"
      ? targetIndex
      : events.findIndex((event, index) => index > targetIndex && event.type === "reset");
  const openingIndex = events.findLastIndex(
    (event, index) => index < closingIndex && event.type === "reset",
  );
  return events
    .slice(openingIndex + 1, closingIndex + 1)
    .filter((event) => !hiddenIds.includes(event.id))
    .map((event) => event.id);
}

describe("session transcript reader marker projection", () => {
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    setRuntimeConfigSnapshot({});
  });

  afterEach(() => envSnapshot.restore());

  async function writeTranscript(
    sessionId: string,
    events: Array<{ id: string }>,
  ): Promise<SessionTranscriptReadScope> {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      ...events.map((event, index) => ({ ...event, parentId: events[index - 1]?.id ?? null })),
    ]);
    return scope;
  }

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

  test.each([
    scenario(
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
      ["user", "notice", "summary", "after-summary"],
      ["hidden", "missing-display", "numeric-display", "string-display", "runtime-context"],
    ),
    scenario(
      "custom-messages-across-resets",
      [
        message("old-user"),
        customMessage("old-notice", true),
        customMessage("old-hidden", false),
        reset("old-reset"),
        message("middle-user"),
        customMessage("middle-notice", true),
        reset("reset", "middle-user"),
        customMessage("fresh-notice", true),
      ],
      ["middle-user", "reset", "fresh-notice"],
      ["old-hidden"],
    ),
    scenario(
      "compaction",
      [message("before"), compaction("summary", "before"), message("after", "assistant")],
      ["before", "summary", "after"],
    ),
    scenario(
      "reset",
      [
        message("old"),
        message("kept-user"),
        message("kept-assistant", "assistant"),
        reset("reset", "kept-user"),
        message("post-reset", "assistant"),
      ],
      ["kept-user", "kept-assistant", "reset", "post-reset"],
    ),
    scenario(
      "reset-then-compaction",
      [
        message("old"),
        compaction("old-summary", "old"),
        reset("reset"),
        message("fresh"),
        compaction("fresh-summary", "fresh"),
      ],
      ["reset", "fresh", "fresh-summary"],
    ),
    scenario(
      "empty-reset-adjacent-compactions",
      [
        message("old"),
        compaction("old-summary", "old"),
        reset("reset"),
        compaction("fresh-summary", "reset"),
        compaction("newest-summary", "reset"),
      ],
      ["reset", "fresh-summary", "newest-summary"],
    ),
    scenario(
      "kept-reset-adjacent-compactions",
      [
        message("old"),
        compaction("old-summary", "old"),
        message("kept-user"),
        message("orphan-tool", "toolResult"),
        message("kept-assistant", "assistant"),
        reset("reset", "kept-user"),
        compaction("fresh-summary", "kept-user"),
        compaction("newest-summary", "kept-user"),
      ],
      ["kept-user", "kept-assistant", "reset", "fresh-summary", "newest-summary"],
    ),
    scenario(
      "repeated-resets",
      [
        message("old"),
        compaction("old-summary", "old"),
        reset("old-reset"),
        message("middle"),
        compaction("middle-summary", "middle"),
        reset("reset"),
        message("fresh"),
        compaction("fresh-summary", "fresh"),
        compaction("newest-summary", "fresh"),
        message("after", "assistant"),
      ],
      ["reset", "fresh", "fresh-summary", "newest-summary", "after"],
    ),
  ])(
    "projects $name boundaries through every SQLite history read",
    async ({ name, events, expectedIds, hiddenIds }) => {
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
      const expectedVisits = events
        .filter((event) => event.type === "message")
        .map((event, index) => ({ id: event.id, message: event.message, seq: index + 1 }))
        .filter((event) => expectedIds.includes(event.id))
        .map((entry) => ({ message: entry.message, seq: entry.seq }));
      const visited: Array<{ message: unknown; seq: number }> = [];
      await expect(
        visitSessionMessagesAsync(scope, (entryMessage, seq) =>
          visited.push({ message: entryMessage, seq }),
        ),
      ).resolves.toBe(expectedVisits.length);
      expect(visited).toEqual(expectedVisits);
      expect(messageIds(recent.messages)).toEqual(expectedIds.slice(-2));
      expect(recent.totalMessages).toBe(expectedIds.length);
      expect(await readCount(scope)).toBe(expectedIds.length);
      for (const [index, id] of expectedIds.entries()) {
        const page = await readPage(scope, {
          maxMessages: 1,
          offset: expectedIds.length - index - 1,
        });
        const byId = await readById(scope, id);
        const anchored = await readAround(scope, {
          messageId: id,
          maxMessages: 10,
        });
        expect(await readMatching(scope, id)).toEqual([full[index]]);
        expect(messageIds(page.messages)).toEqual([id]);
        expect(page.totalMessages).toBe(expectedIds.length);
        expect(byId).toMatchObject({
          found: true,
          seq: index + 1,
          message: { __openclaw: { id, seq: index + 1 } },
        });
        const entry = events.find((event) => event.id === id)!;
        expect(byId.message).toMatchObject(
          entry.type === "message"
            ? entry.message
            : entry.type === "custom_message"
              ? {
                  role: "custom",
                  customType: entry.customType,
                  content: entry.content,
                  display: true,
                  timestamp: Date.parse(timestamp),
                }
              : {
                  role: "system",
                  content: [
                    { type: "text", text: entry.type === "compaction" ? "Compaction" : "Reset" },
                  ],
                  timestamp: Date.parse(timestamp),
                  __openclaw: { kind: entry.type },
                },
        );
        if (entry.type === "compaction") {
          expect(full[index]).toMatchObject({
            __openclaw: { tokensBefore: 100, tokensAfter: 25 },
          });
        }
        expect(anchored).toMatchObject({ found: true, totalMessages: expectedIds.length });
        expect(messageIds(anchored.messages)).toEqual(expectedIds);
      }
      for (const { id } of events.filter((event) => !expectedIds.includes(event.id))) {
        expect(await readMatching(scope, id)).toEqual([]);
        if (hiddenIds.includes(id)) {
          expect(await readById(scope, id)).toMatchObject({ found: false });
          expect(
            await readAround(scope, {
              messageId: id,
              maxMessages: 10,
            }),
          ).toMatchObject({ found: false, messages: [] });
          continue;
        }
        const historicalIds = historicalWindowIds(events, id, hiddenIds);
        expect(await readById(scope, id)).toMatchObject({
          found: true,
          message: { __openclaw: { id } },
        });
        const anchored = await readAround(scope, {
          messageId: id,
          maxMessages: 10,
        });
        expect(anchored).toMatchObject({ found: true, totalMessages: historicalIds.length });
        expect(messageIds(anchored.messages)).toEqual(historicalIds);
        expect(messageIds(anchored.messages)).not.toEqual(expectedIds);
      }
    },
  );
});
