import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
  resolveSessionTranscriptDatabasePath,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionTranscriptDeltaReader } from "../config/sessions/session-transcript-delta-read.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
  withSessionTranscriptWriteLock,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-visible-transcript-");
const decodeCursor = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
const rewriteCursor = (cursor: string, patch: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ ...decodeCursor(cursor), ...patch }), "utf8").toString("base64url");
async function offThread<T>(read: () => T) {
  const sql = observeHostDataSql();
  try {
    const result = await read();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}
function visibleReader(scope: SessionTranscriptReadParams, maxBytes = 10_000, maxMessages = 1) {
  return (cursor?: string, limits = { maxBytes, maxMessages }) =>
    readSessionTranscriptVisibleMessageDelta({ ...scope, cursor, ...limits });
}
function expectReset(
  page: ReturnType<typeof readSessionTranscriptVisibleMessageDelta>,
  reason: string,
) {
  return expect(page).resolves.toMatchObject({ kind: "reset", reason });
}
const rawMessage = (content: string) =>
  expect.objectContaining({
    event: expect.objectContaining({ message: expect.objectContaining({ content }) }),
  });
function append(
  scope: SessionTranscriptReadParams,
  role: string,
  content: string,
  now?: number,
  parentId?: string,
  eventId?: string,
) {
  return appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role, content },
    now,
    parentId,
    eventId,
  });
}

describe("session transcript visible cursor SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  async function seed(
    sessionId: string,
    overrides: Partial<SessionTranscriptReadParams> = {},
    updatedAt = 10,
  ) {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
      ...overrides,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt });
    return scope;
  }

  it("settles nested reads through lock preparation, cancellation, and closure", async ({
    signal,
  }) => {
    const scope = await seed(
      "nested-worker-read",
      {
        storePath: path.join(tempDir, "nested-worker-read.sqlite"),
      },
      1,
    );
    await append(scope, "user", "before nested read");
    const resumeLateRead = createDeferred();
    let lateRead: Promise<unknown> | undefined;
    await withSessionTranscriptWriteLock(scope, async (locked) => {
      await expect(locked.readEvents()).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "before nested read" }),
        }),
      );
      await expect(
        withSessionTranscriptDeltaReader(scope, (reader) => reader.raw({ maxEvents: 10 }), signal),
      ).resolves.toMatchObject({
        kind: "page",
        events: expect.arrayContaining([rawMessage("before nested read")]),
      });
      await locked.appendMessage({
        message: { role: "assistant", content: "after nested read" },
        prepareMessageAfterIdempotencyCheckAsync: async (message) => {
          await expect(readSessionTranscriptVisibleMessageDelta(scope)).resolves.toMatchObject({
            kind: "page",
            entries: [{ message: { role: "user", content: "before nested read" } }],
          });
          return message;
        },
      });
      await expect(readSessionTranscriptVisibleMessageDelta(scope)).resolves.toMatchObject({
        kind: "page",
        entries: [
          { message: { role: "user", content: "before nested read" } },
          { message: { role: "assistant", content: "after nested read" } },
        ],
      });
      await expect(readSessionTranscriptWatermarkAsync(scope)).resolves.toMatchObject({
        maxSeq: 2,
      });
      const cancel = new AbortController();
      await expect(
        withSessionTranscriptDeltaReader(
          scope,
          async (reader) => {
            const preparing = createDeferred();
            const finishPreparation = createDeferred();
            const writing = locked.appendMessage({
              message: { role: "user", content: "after cancelled read" },
              prepareMessageAfterIdempotencyCheckAsync: async (message) => {
                preparing.resolve();
                await withinTest(finishPreparation.promise, signal);
                return message;
              },
            });
            try {
              await withinTest(
                awaitGateBeforeSettlement(preparing.promise, writing, "Append skipped preparation"),
                signal,
              );
              const reading = reader.raw({ maxEvents: 10 });
              cancel.abort(new Error("nested reader cancelled"));
              await expect(reading).rejects.toThrow("nested reader cancelled");
            } finally {
              finishPreparation.resolve();
              await writing;
            }
          },
          cancel.signal,
        ),
      ).rejects.toThrow("nested reader cancelled");
      lateRead = resumeLateRead.promise.then(() => readSessionTranscriptRawDelta(scope));
    });
    const lateRejection = expect(lateRead).rejects.toThrow("Transcript write context is closed");
    resumeLateRead.resolve();
    await lateRejection;
    await expect(readSessionTranscriptRawDelta({ ...scope, maxEvents: 10 })).resolves.toMatchObject(
      {
        kind: "page",
        events: expect.arrayContaining([rawMessage("after cancelled read")]),
      },
    );
  });

  it.each([readSessionTranscriptRawDelta, readSessionTranscriptVisibleMessageDelta])(
    "rejects invalid bounds even when the transcript database is absent",
    async (read) => {
      await expect(
        read({
          agentId: "main",
          sessionId: "missing",
          sessionKey: "agent:main:missing",
          storePath,
          maxBytes: 0,
        }),
      ).rejects.toThrow(RangeError);
    },
  );

  it.each(["raw", "visible"] as const)(
    "reads %s deltas off the caller thread and observes foreign rewrite generations",
    async (kind) => {
      const scope = await seed(`worker-delta-${kind}`);
      await append(scope, "user", "persisted delta");
      const read = (cursor?: string) =>
        kind === "raw"
          ? readSessionTranscriptRawDelta({ ...scope, cursor, maxEvents: 10 })
          : readSessionTranscriptVisibleMessageDelta({ ...scope, cursor, maxMessages: 10 });
      const first = await offThread(() => read());
      assert(first.kind === "page", "expected a populated delta");
      // Serialize fixture setup with background writers; the peer still bypasses publication.
      await agentWriteAdmission.runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
        () => {
          const foreign = new DatabaseSync(resolveSessionTranscriptDatabasePath(scope));
          try {
            expect(
              foreign
                .prepare(
                  "UPDATE transcript_rewrite_watermarks SET generation = generation || '-foreign' WHERE session_id = ?",
                )
                .run(scope.sessionId).changes,
            ).toBe(1);
          } finally {
            foreign.close();
          }
        },
      );
      await expect(offThread(() => read(first.cursor))).resolves.toMatchObject({
        kind: "reset",
        reason: "generation_mismatch",
      });
    },
  );

  it("repairs a shared-store projection through its physical owner and retains logical cursors", async () => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "shared-history.sqlite"),
    });
    const scope = await seed("shared-visible-repair", {
      agentId: "other",
      sessionKey: "agent:other:shared-visible-repair",
      storePath: database.path,
    });
    await append(scope, "user", "Shared history survives projection repair");
    const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    await expect(readSessionTranscriptVisibleMessageDelta(scope)).resolves.toEqual({
      kind: "unavailable",
      reason: "projection_rebuilding",
    });
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    const repaired = await readSessionTranscriptVisibleMessageDelta(scope);
    expect(repaired).toMatchObject({
      kind: "page",
      entries: [
        { message: { role: "user", content: "Shared history survives projection repair" } },
      ],
      hasMore: false,
    });
    assert(repaired.kind === "page", "expected repaired shared-store transcript page");
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...scope, cursor: repaired.cursor }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [],
      hasMore: false,
    });
  });

  it("pages appends and resets when the active branch changes", async () => {
    const scope = await seed("visible-delta-session", {
      sessionKey: "agent:main:visible-delta",
    });
    const read = visibleReader(scope);
    const root = await append(scope, "user", "root", 1_000);
    const firstBranch = await append(scope, "assistant", "first branch", 2_000, root?.messageId);
    assert(root && firstBranch, "expected visible delta setup messages");
    const first = await read();
    expect(first).toMatchObject({
      kind: "page",
      entries: [
        {
          entryId: root.messageId,
          message: { role: "user", content: "root" },
          parentId: null,
        },
      ],
      hasMore: true,
    });
    assert(first.kind === "page", "expected first visible transcript page");

    for (const cursor of [
      `${first.cursor}!`,
      `${first.cursor}=`,
      rewriteCursor(first.cursor, { extra: true }),
    ]) {
      await expectReset(read(cursor), "invalid_cursor");
    }

    const second = await read(first.cursor);
    expect(second).toMatchObject({
      kind: "page",
      entries: [
        {
          entryId: firstBranch.messageId,
          message: { role: "assistant", content: "first branch" },
          parentId: root.messageId,
        },
      ],
      hasMore: false,
    });
    assert(second.kind === "page", "expected second visible transcript page");
    const movedAnchorCursor = rewriteCursor(second.cursor, { lastMessagePosition: 0 });
    await expectReset(read(movedAnchorCursor), "anchor_moved");

    const appended = await append(scope, "user", "linear append", 3_000, firstBranch.messageId);
    await expect(read(second.cursor)).resolves.toMatchObject({
      kind: "page",
      entries: [{ entryId: appended?.messageId, message: { content: "linear append" } }],
      hasMore: false,
    });

    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-replacement-branch",
      parentId: appended?.messageId,
      targetId: root.messageId,
    });
    const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
    // Worker reads can outlast repair; test the settled cursor contract here.
    startSessionTranscriptIndexReconcile(databaseOptions);
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    await expectReset(read(second.cursor), "anchor_missing");
    await append(
      scope,
      "assistant",
      "replacement branch",
      4_000,
      "select-replacement-branch",
      "replacement-branch",
    );
    startSessionTranscriptIndexReconcile(databaseOptions);
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    const reset = await read(second.cursor);
    expect(reset).toMatchObject({ kind: "reset", reason: "anchor_missing" });
    assert(reset.kind === "reset", "expected visible branch reset");
    await expect(read(reset.cursor, { maxBytes: 10_000, maxMessages: 10 })).resolves.toMatchObject({
      kind: "page",
      entries: [
        { entryId: root.messageId, parentId: null },
        { entryId: "replacement-branch", parentId: root.messageId },
      ],
      hasMore: false,
    });
  });

  it("bounds pages before parsing oversized entries", async () => {
    const scope = await seed("visible-delta-bounds");
    const read = visibleReader(scope, 10);
    const content = "x".repeat(200);
    await append(scope, "user", content, 1_000);

    const invalid = await read("not-a-cursor");
    expect(invalid).toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    assert(invalid.kind === "reset", "expected invalid visible cursor reset");
    const inconsistentBootstrapCursor = rewriteCursor(invalid.cursor, { lastMessagePosition: 0 });
    await expectReset(read(inconsistentBootstrapCursor), "invalid_cursor");
    const bounded = await read(invalid.cursor);
    expect(bounded).toMatchObject({
      kind: "page",
      entries: [],
      hasMore: true,
      requiredBytes: expect.any(Number),
      serializedBytes: 0,
    });
    assert(
      bounded.kind === "page" && bounded.requiredBytes !== undefined,
      "expected oversized visible entry metadata",
    );
    await expect(
      read(bounded.cursor, { maxBytes: bounded.requiredBytes, maxMessages: 1 }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [{ message: { role: "user", content } }],
      hasMore: false,
      serializedBytes: bounded.requiredBytes,
    });
  });

  it("stops a visible cursor before the admitted row and resumes it after the fence", async () => {
    const scope = await seed("visible-delta-fence");
    const read = visibleReader(scope, 100_000, 10);
    const prior = await append(scope, "user", "same prompt", 1_000);
    const admitted = await append(scope, "user", "same prompt", 2_000, prior?.messageId);
    const assistant = await append(scope, "assistant", "answer", 3_000, admitted?.messageId);
    assert(prior && admitted?.anchor && assistant, "expected visible fence setup and anchor");
    const fenced = await runWithSessionTranscriptReadFence(
      { ...admitted.anchor, logicalTurnId: "visible-delta-fence", role: "user" },
      () => read(),
    );
    expect(fenced).toMatchObject({
      kind: "page",
      entries: [{ entryId: prior.messageId, message: { content: "same prompt" } }],
      hasMore: false,
    });
    assert(fenced.kind === "page", "expected fenced visible transcript page");

    await expect(read(fenced.cursor)).resolves.toMatchObject({
      kind: "page",
      entries: [
        { entryId: admitted.messageId, message: { content: "same prompt" } },
        { entryId: assistant.messageId, message: { content: "answer" } },
      ],
      hasMore: false,
    });
  });
});
