import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import * as agentWriteAdmission from "../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-visible-transcript-");

describe("session transcript visible cursor SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  it("settles nested reads through lock preparation, cancellation, and closure", async ({
    signal,
  }) => {
    const scope = {
      agentId: "main",
      sessionId: "nested-worker-read",
      sessionKey: "agent:main:nested-worker-read",
      storePath: path.join(tempDir, "nested-worker-read.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "before nested read" },
    });
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
        events: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              message: expect.objectContaining({ content: "before nested read" }),
            }),
          }),
        ]),
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
        events: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              message: expect.objectContaining({ content: "after cancelled read" }),
            }),
          }),
        ]),
      },
    );
  });

  it("refuses a queued delta read after its prepared executor generation is replaced", async ({
    signal,
  }) => {
    const scope = {
      agentId: "main",
      sessionId: "prepared-delta-generation",
      sessionKey: "agent:main:prepared-delta-generation",
      storePath: path.join(tempDir, "prepared-delta.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "retained transcript" },
    });
    const execution = captureOpenClawAgentDatabaseExecution({
      agentId: scope.agentId,
      path: scope.storePath,
    });
    if (!execution.capturePreparedGenerationClaim()) {
      await execution.release();
      throw new Error("The fixture requires its admitted session writer");
    }
    const entered = createDeferred();
    const resume = createDeferred();
    const writerEntered = createDeferred();
    const replaceGeneration = createDeferred();
    const reading = withSessionTranscriptDeltaReader(
      scope,
      async (reader) => {
        entered.resolve();
        await withinTest(resume.promise, signal);
        return reader.raw({ maxEvents: 10 });
      },
      signal,
    );
    const refused = expect(reading).rejects.toThrow(
      "Agent database execution generation was replaced",
    );
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: () => execution.assertCurrent(),
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            execution.assertCurrent();
            if (!grant()) {
              throw new Error("Fixture execution admission expired");
            }
          }, binding.attachment),
        });
      },
    };
    let writing: Promise<void> | undefined;
    let restoreAdmission = () => {};
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          reading,
          "Delta read ended before retaining its prepared owner",
        ),
        signal,
      );
      writing = agentWriteAdmission.runOpenClawAgentWriteAdmission(execution, async () => {
        writerEntered.resolve();
        await withinTest(replaceGeneration.promise, signal);
        const failure = new Error("Retire the original native generation");
        await expect(
          execution.runExisting(
            source,
            async () => {
              throw failure;
            },
            { retireNativeOnFailure: true },
          ),
        ).rejects.toBe(failure);
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 2 });
      });
      await withinTest(writerEntered.promise, signal);
      const queued = createDeferred();
      const admit = agentWriteAdmission.runOpenClawAgentWriteAdmission;
      const admission = vi
        .spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation((...args) => {
          const pending = admit(...args);
          if (args[0].path === scope.storePath && args[4] === signal) {
            queued.resolve();
          }
          return pending;
        });
      restoreAdmission = () => admission.mockRestore();
      resume.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          queued.promise,
          reading,
          "Delta read bypassed the earlier admitted writer",
        ),
        signal,
      );
      restoreAdmission();
      replaceGeneration.resolve();
      await withinTest(writing, signal);
      await refused;
      const fresh = await readSessionTranscriptVisibleMessageDelta({ ...scope, maxMessages: 10 });
      expect(fresh).toMatchObject({
        kind: "page",
        entries: [{ message: { role: "user", content: "retained transcript" } }],
      });
    } finally {
      restoreAdmission();
      resume.resolve();
      replaceGeneration.resolve();
      await Promise.allSettled([reading, writing, refused]);
      await execution.release();
    }
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
      const scope = {
        agentId: "main",
        sessionId: `worker-delta-${kind}`,
        sessionKey: `agent:main:worker-delta-${kind}`,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "persisted delta" },
      });
      const read = (cursor?: string) =>
        kind === "raw"
          ? readSessionTranscriptRawDelta({ ...scope, cursor, maxEvents: 10 })
          : readSessionTranscriptVisibleMessageDelta({ ...scope, cursor, maxMessages: 10 });
      const firstSql = observeHostDataSql();
      let first: Awaited<ReturnType<typeof read>>;
      try {
        first = await read();
        expect(firstSql.queries).toEqual([]);
      } finally {
        firstSql.restore();
      }
      if (first.kind !== "page") {
        throw new Error("expected a populated delta");
      }
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
      const nextSql = observeHostDataSql();
      try {
        await expect(read(first.cursor)).resolves.toMatchObject({
          kind: "reset",
          reason: "generation_mismatch",
        });
        expect(nextSql.queries).toEqual([]);
      } finally {
        nextSql.restore();
      }
    },
  );

  it("repairs a shared-store projection through its physical owner and retains logical cursors", async () => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "shared-history.sqlite"),
    });
    const scope = {
      agentId: "other",
      sessionId: "shared-visible-repair",
      sessionKey: "agent:other:shared-visible-repair",
      storePath: database.path,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "Shared history survives projection repair" },
    });
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
    if (repaired.kind !== "page") {
      throw new Error("expected repaired shared-store transcript page");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...scope, cursor: repaired.cursor }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [],
      hasMore: false,
    });
  });

  it("pages appends and resets when the active branch changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-delta-session",
      sessionKey: "agent:main:visible-delta",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const root = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "root" },
      now: 1_000,
    });
    const firstBranch = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "first branch" },
      parentId: root?.messageId,
      now: 2_000,
    });
    if (!root || !firstBranch) {
      throw new Error("expected visible delta setup messages");
    }

    const first = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      maxBytes: 10_000,
      maxMessages: 1,
    });
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
    if (first.kind !== "page") {
      throw new Error("expected first visible transcript page");
    }

    const decodedCursor = JSON.parse(
      Buffer.from(first.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const nonCanonicalCursors = [
      `${first.cursor}!`,
      `${first.cursor}=`,
      Buffer.from(JSON.stringify({ ...decodedCursor, extra: true }), "utf8").toString("base64url"),
    ];
    for (const cursor of nonCanonicalCursors) {
      await expect(
        readSessionTranscriptVisibleMessageDelta({
          ...scope,
          cursor,
          maxBytes: 10_000,
          maxMessages: 1,
        }),
      ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    }

    const second = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: first.cursor,
      maxBytes: 10_000,
      maxMessages: 1,
    });
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
    if (second.kind !== "page") {
      throw new Error("expected second visible transcript page");
    }
    const movedAnchorCursor = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(second.cursor, "base64url").toString("utf8")) as object),
        lastMessagePosition: 0,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: movedAnchorCursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "anchor_moved" });

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "linear append" },
      parentId: firstBranch.messageId,
      now: 3_000,
    });
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: second.cursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
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
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: second.cursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "anchor_missing" });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: "replacement-branch",
      parentId: "select-replacement-branch",
      message: { role: "assistant", content: "replacement branch" },
      now: 4_000,
    });
    startSessionTranscriptIndexReconcile(databaseOptions);
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    const reset = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: second.cursor,
      maxBytes: 10_000,
      maxMessages: 1,
    });
    expect(reset).toMatchObject({ kind: "reset", reason: "anchor_missing" });
    if (reset.kind !== "reset") {
      throw new Error("expected visible branch reset");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: reset.cursor,
        maxBytes: 10_000,
        maxMessages: 10,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [
        { entryId: root.messageId, parentId: null },
        { entryId: "replacement-branch", parentId: root.messageId },
      ],
      hasMore: false,
    });
  });

  it("bounds pages before parsing oversized entries", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-delta-bounds",
      sessionKey: "agent:main:visible-delta-bounds",
      storePath,
    };
    const content = "x".repeat(200);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content },
      now: 1_000,
    });

    const invalid = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: "not-a-cursor",
      maxBytes: 10,
      maxMessages: 1,
    });
    expect(invalid).toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    if (invalid.kind !== "reset") {
      throw new Error("expected invalid visible cursor reset");
    }
    const inconsistentBootstrapCursor = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(invalid.cursor, "base64url").toString("utf8")) as object),
        lastMessagePosition: 0,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: inconsistentBootstrapCursor,
        maxBytes: 10,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    const bounded = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: invalid.cursor,
      maxBytes: 10,
      maxMessages: 1,
    });
    expect(bounded).toMatchObject({
      kind: "page",
      entries: [],
      hasMore: true,
      requiredBytes: expect.any(Number),
      serializedBytes: 0,
    });
    if (bounded.kind !== "page" || bounded.requiredBytes === undefined) {
      throw new Error("expected oversized visible entry metadata");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: bounded.cursor,
        maxBytes: bounded.requiredBytes,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [{ message: { role: "user", content } }],
      hasMore: false,
      serializedBytes: bounded.requiredBytes,
    });
  });

  it("stops a visible cursor before the admitted row and resumes it after the fence", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-delta-fence",
      sessionKey: "agent:main:visible-delta-fence",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const prior = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "same prompt" },
      now: 1_000,
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "same prompt" },
      parentId: prior?.messageId,
      now: 2_000,
    });
    const assistant = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "answer" },
      parentId: admitted?.messageId,
      now: 3_000,
    });
    if (!prior || !admitted || !assistant) {
      throw new Error("expected visible fence setup messages");
    }

    if (!admitted.anchor) {
      throw new Error("expected admitted transcript anchor");
    }
    const fenced = await runWithSessionTranscriptReadFence(
      { ...admitted.anchor, logicalTurnId: "visible-delta-fence", role: "user" },
      async () =>
        await readSessionTranscriptVisibleMessageDelta({
          ...scope,
          maxBytes: 100_000,
          maxMessages: 10,
        }),
    );
    expect(fenced).toMatchObject({
      kind: "page",
      entries: [{ entryId: prior.messageId, message: { content: "same prompt" } }],
      hasMore: false,
    });
    if (fenced.kind !== "page") {
      throw new Error("expected fenced visible transcript page");
    }

    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: fenced.cursor,
        maxBytes: 100_000,
        maxMessages: 10,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [
        { entryId: admitted.messageId, message: { content: "same prompt" } },
        { entryId: assistant.messageId, message: { content: "answer" } },
      ],
      hasMore: false,
    });
  });
});
