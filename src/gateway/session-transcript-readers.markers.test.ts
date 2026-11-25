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
type Scenario = [name: string, events: Event[], visible: string, hidden?: string];
const ids = (text: string) => text.split(" ");
const old = message("old");
const oldSummary = compaction("old-summary", "old");
const oldReset = reset("old-reset");
const emptyReset = reset("reset");
const keptUser = message("kept-user");
const keptAssistant = message("kept-assistant", "assistant");
const keptReset = reset("reset", "kept-user");
const fresh = message("fresh");
const freshSummary = compaction("fresh-summary", "fresh");
const after = message("after", "assistant");
const before = message("before");
const summary = compaction("summary", "before");
const compactedPast = [old, oldSummary];
const freshTurn = [fresh, freshSummary];
const resetSummaries = [
  compaction("fresh-summary", "reset"),
  compaction("newest-summary", "reset"),
];
const keptSummaries = [
  compaction("fresh-summary", "kept-user"),
  compaction("newest-summary", "kept-user"),
];
const middleTurn = [message("middle"), compaction("middle-summary", "middle")];
const orphan = message("orphan-tool", "toolResult");

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

function projectedMessage(entry: Event) {
  if (entry.type === "message") {
    return entry.message;
  }
  const timed = { timestamp: Date.parse(timestamp) };
  if (entry.type === "custom_message") {
    return {
      ...timed,
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: true,
    };
  }
  return {
    ...timed,
    role: "system",
    __openclaw: { kind: entry.type },
    content: [{ type: "text", text: entry.type === "compaction" ? "Compaction" : "Reset" }],
  };
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
      "custom-messages-across-resets",
      [
        message("old-user"),
        customMessage("old-notice", true),
        customMessage("old-hidden", false),
        oldReset,
        message("middle-user"),
        customMessage("middle-notice", true),
        reset("reset", "middle-user"),
        customMessage("fresh-notice", true),
      ],
      "middle-user reset fresh-notice",
      "old-hidden",
    ],
    ["compaction", [before, summary, after], "before summary after"],
    [
      "reset",
      [old, keptUser, keptAssistant, keptReset, message("post-reset", "assistant")],
      "kept-user kept-assistant reset post-reset",
    ],
    [
      "reset-then-compaction",
      [...compactedPast, emptyReset, ...freshTurn],
      "reset fresh fresh-summary",
    ],
    [
      "empty-reset-adjacent-compactions",
      [...compactedPast, emptyReset, ...resetSummaries],
      "reset fresh-summary newest-summary",
    ],
    [
      "kept-reset-adjacent-compactions",
      [...compactedPast, keptUser, orphan, keptAssistant, keptReset, ...keptSummaries],
      "kept-user kept-assistant reset fresh-summary newest-summary",
    ],
    [
      "repeated-resets",
      [
        ...compactedPast,
        oldReset,
        ...middleTurn,
        emptyReset,
        ...freshTurn,
        compaction("newest-summary", "fresh"),
        after,
      ],
      "reset fresh fresh-summary newest-summary after",
    ],
  ])(
    "projects %s boundaries through every SQLite history read",
    async (name, events, visible, hidden) => {
      const expectedIds = ids(visible);
      const hiddenIds = hidden ? ids(hidden) : [];
      const scope = await writeTranscript(`reader-${name}`, events);
      const around = (messageId: string) => readAround(scope, { messageId, maxMessages: 10 });
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
      for (const entry of events) {
        const { id } = entry;
        const index = expectedIds.indexOf(id);
        const byId = await readById(scope, id);
        const anchored = await around(id);
        expect(await readMatching(scope, id)).toEqual(index < 0 ? [] : [full[index]]);
        if (index < 0) {
          if (hiddenIds.includes(id)) {
            expect(byId).toMatchObject({ found: false });
            expect(anchored).toMatchObject({ found: false, messages: [] });
          } else {
            const historicalIds = historicalWindowIds(events, id, hiddenIds);
            expect(byId).toMatchObject({ found: true, message: { __openclaw: { id } } });
            expect(anchored).toMatchObject({ found: true, totalMessages: historicalIds.length });
            expect(messageIds(anchored.messages)).toEqual(historicalIds);
            expect(messageIds(anchored.messages)).not.toEqual(expectedIds);
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
        expect(byId.message).toMatchObject(projectedMessage(entry));
        if (entry.type === "compaction") {
          expect(full[index]).toMatchObject({
            __openclaw: { tokensBefore: 100, tokensAfter: 25 },
          });
        }
        expect(anchored).toMatchObject({ found: true, totalMessages: expectedIds.length });
        expect(messageIds(anchored.messages)).toEqual(expectedIds);
      }
    },
  );
});
