import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "../../state/openclaw-agent-board-schema.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
import { writeSessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readSessionEntrySelectionSnapshot,
  readLifecycleTargetSnapshot,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry } from "./session-accessor.sqlite-entry.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import type { SessionEntry } from "./types.js";

function entryFixture(state: OpenClawTestState, sessionId: string) {
  const key = `agent:main:${sessionId}`;
  const scope = { agentId: "main", env: state.env, sessionKey: key };
  const database = openOpenClawAgentDatabase(scope);
  const write = (fields: Partial<SessionEntry>) =>
    runOpenClawAgentWriteTransaction(
      (writer) => writeSessionEntry(writer, key, { sessionId, updatedAt: 10, ...fields }),
      scope,
    );
  return { key, scope, database, write };
}

const withEntryFixture = (
  id: string,
  run: (fixture: ReturnType<typeof entryFixture>) => void | Promise<void>,
) => withOpenClawTestState({ scenario: "minimal" }, async (state) => run(entryFixture(state, id)));

type Writer = Parameters<typeof writeSessionEntryPatchInDatabase>[0];
type Patch = Parameters<typeof writeSessionEntryPatchInDatabase>[1];

function expectAppend(scope: Parameters<typeof appendTranscriptMessageSync>[0], content: string) {
  expect(appendTranscriptMessageSync(scope, { message: { role: "user", content } }).ok).toBe(true);
}

function readObservation(writer: Writer, sessionId: string) {
  return writer.db
    .prepare(
      "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
    )
    .get(sessionId);
}

function patchEntry(
  writer: Writer,
  fresh: Patch["fresh"],
  fields: Partial<SessionEntry>,
  options: Patch["options"] = {},
) {
  const current = fresh[0];
  if (!current) {
    throw new Error("Missing entry before patch");
  }
  return writeSessionEntryPatchInDatabase(writer, {
    sessionKey: current.sessionKey,
    fresh,
    writeBase: current.entry,
    next: { ...current.entry, ...fields },
    options,
  });
}

it("publishes canonical side metadata through cold, warm, and field-only writes", () =>
  withEntryFixture("cache-metadata", async ({ scope, database, write: writeFields }) => {
    let published: ReturnType<typeof readPreparedSessionEntryChange>;
    const unsubscribe = sessionChanges.subscribeProjection((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        published = readPreparedSessionEntryChange(change, scope.sessionKey);
      }
    });
    const expectAbsentMetadata = (entry: SessionEntry | undefined) => {
      expect(entry).toMatchObject({ sessionId: "cache-metadata" });
      for (const field of ["owner", "participants", "participantCount"]) {
        expect(entry).not.toHaveProperty(field);
      }
    };
    const write = (label: string, updatedAt = 10) =>
      writeFields({
        updatedAt,
        label,
        skillsSnapshot: { prompt: "saved prompt", skills: [] },
      });
    const current = () =>
      readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db))?.get(
        scope.sessionKey,
      );
    const owner: NonNullable<SessionEntry["owner"]> = {
      actor: { type: "human", id: "cache-owner" },
    };
    const assignOwner = (assignment: typeof owner | undefined) =>
      runOpenClawAgentWriteTransaction(
        (writer) => replaceSessionOwnerInTransaction(writer, scope.sessionKey, assignment),
        scope,
      );
    try {
      write("cold");
      expectAbsentMetadata(published?.entry);
      expectAbsentMetadata(published?.fullEntry);
      expect(published?.fullEntry?.skillsSnapshot?.prompt).toBe("saved prompt");

      readSessionEntryCache(database, { cache: true, projection: "list" });
      write("warm", 20);
      expect(current()).toMatchObject({ label: "warm", updatedAt: 20 });
      expectAbsentMetadata(current());
      expectAbsentMetadata(published?.entry);

      expect(assignOwner(owner)).toBe(true);
      readSessionEntryCache(database, { cache: true, projection: "list" });
      expect(current()?.owner).toEqual(owner);
      expect(assignOwner(undefined)).toBe(true);
      expectAbsentMetadata(current());

      expect(assignOwner(owner)).toBe(true);
      expect(
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "cache-participant" },
          promptedAt: 10,
        }),
      ).toBe("inserted");
      expect(current()).toMatchObject({
        owner,
        participants: [{ identity: { type: "agent", id: "cache-participant" } }],
        participantCount: 1,
      });
      expect(assignOwner(undefined)).toBe(true);
      expect(current()).not.toHaveProperty("owner");
      expect(current()).toMatchObject({
        participants: [{ identity: { type: "agent", id: "cache-participant" } }],
        participantCount: 1,
      });
    } finally {
      unsubscribe();
    }
  }));

it("skips unchanged entry and snapshot writes while retaining current transcript observation", () =>
  withEntryFixture("entry-noop", async ({ scope, database, write }) => {
    const skillsSnapshot = { prompt: "saved prompt", skills: [] };
    write({ skillsSnapshot });
    const assertCommitAllowed = vi.fn();
    const savedPatch = () => ({ skillsSnapshot: structuredClone(skillsSnapshot) });
    const patch = async (fields: Partial<SessionEntry>) =>
      runOpenClawAgentWriteTransaction(
        (writer) =>
          patchEntry(
            writer,
            readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true),
            fields,
            { assertCommitAllowed },
          ).entry,
        scope,
      );
    // Settle the initial transcript observation before measuring unchanged rows.
    await patch({});
    const writeTables = new Map<string, "nodes" | "windows" | "snapshots">([
      ["session_nodes", "nodes"],
      ["session_windows", "windows"],
      ["session_entry_snapshots", "snapshots"],
    ] as const);
    const sql = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["nodes", "windows", "snapshots"],
      (query) =>
        writeTables.get(/^(?:insert into|update|delete from) "([^"]+)"/iu.exec(query)?.[1] ?? "") ??
        null,
    );
    try {
      assertCommitAllowed.mockClear();
      await expect(patch(savedPatch())).resolves.toMatchObject({ updatedAt: 10, skillsSnapshot });
      expect(sql.counts).toEqual({ nodes: 0, windows: 0, snapshots: 0 });
      expect(assertCommitAllowed).toHaveBeenCalled();

      await patch({
        lastRunError: "retained error",
        ...savedPatch(),
      });
      expect(sql.counts).toEqual({ nodes: 1, windows: 0, snapshots: 0 });
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
        lastRunError: "retained error",
        skillsSnapshot,
      });

      expectAppend({ ...scope, sessionId: "entry-noop" }, "new transcript content");
      const before = { ...sql.counts };
      const watermark = () => readObservation(database, "entry-noop");
      const unobserved = watermark();
      expect(unobserved?.transcript_observed_at).not.toBe(unobserved?.transcript_updated_at);
      await patch(savedPatch());
      expect(sql.counts).toEqual({ ...before, windows: before.windows + 1 });
      const observed = watermark();
      expect(observed?.transcript_observed_at).toBe(observed?.transcript_updated_at);
      const settled = { ...sql.counts };
      await patch({});
      expect(sql.counts).toEqual(settled);
    } finally {
      sql.restore();
    }
  }));

it.each(["entry", "target"] as const)(
  "publishes exact %s patch postimages without rereading written facts",
  (selection) =>
    withEntryFixture("entry-postimage", ({ key, scope, database, write }) => {
      const readSnapshot = (writer: typeof database) =>
        selection === "entry"
          ? readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true)
          : readLifecycleTargetSnapshot(
              writer,
              {
                canonicalKey: scope.sessionKey,
                storeKeys: [scope.sessionKey, "agent:main:absent-postimage-alias"],
              },
              { includeWindowFacts: true },
            );
      write({
        activitySummary: {
          version: 1,
          text: "Empty transcript",
          updatedAt: 10,
          sessionId: "entry-postimage",
          generation: null,
          maxSeq: null,
          leafEntryId: null,
          coveredMessages: 0,
          totalMessages: 0,
          omittedContent: false,
        },
        skillsSnapshot: { prompt: "private saved prompt", skills: [] },
      });
      recordSessionParticipant(scope, { identity: { type: "agent", id: "first" }, promptedAt: 10 });
      const addSideTables = (member: string) => {
        database.db
          .prepare("INSERT INTO session_members VALUES (?, ?, 'fixture', 10)")
          .run(scope.sessionKey, member);
        database.db
          .prepare(
            "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'main', 'Synthetic board', 0, 'user', 0)",
          )
          .run(scope.sessionKey);
      };
      runOpenClawAgentWriteTransaction((writer) => {
        ensureOpenClawAgentBoardSchemaInTransaction(writer.db);
        addSideTables("first-member");
      }, scope);
      const sql = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["participants", "windows", "metadata", "watermarks"],
        (query) =>
          /^select "session_key", "identity_namespace".*\bfrom "session_participants"/iu.test(query)
            ? "participants"
            : query.includes('from "session_windows" where "session_id" =')
              ? "windows"
              : query.startsWith("select coalesce(") && query.includes('as "max_seq"')
                ? "watermarks"
                : query.includes('as "member_ids_json"')
                  ? "metadata"
                  : null,
      );
      try {
        runOpenClawAgentWriteTransaction((writer) => {
          const fresh = readSnapshot(writer);
          expect(sql.counts.participants).toBe(0);
          expect(sql.counts.metadata).toBe(selection === "entry" ? 1 : 2);
          const mutation = patchEntry(writer, fresh, {
            lastRunError: "updated",
            skillsSnapshot: {
              prompt: "private saved prompt",
              skills: [],
              resolvedSkills: [],
              discoverySkills: [],
            },
            owner: { actor: { type: "human", id: "unpersisted-owner" } },
            participants: [{ identity: { type: "agent", id: "unpersisted-participant" } }],
            participantCount: 99,
          });
          if (!mutation.identity || !mutation.postimages) {
            throw new Error("Missing committed patch postimage");
          }
          expect(mutation.entry.participants).toEqual([
            expect.objectContaining({ identity: { type: "agent", id: "first" } }),
          ]);
          expect(mutation.entry).not.toHaveProperty("owner");
          mutation.entry.lastRunError = "caller-owned result";
          if (mutation.entry.skillsSnapshot) {
            mutation.entry.skillsSnapshot.prompt = "caller-owned prompt";
          }
          expect(sql.counts.windows).toBe(0);
          const committed = {
            ...mutation.identity,
            pendingArchiveRecovery: false,
            maintenancePlans: [],
            membershipInvalidatedKeys: [],
          };
          const publish = (change: ReturnType<typeof patchEntry>, full = false) => {
            const before = { ...sql.counts };
            const result = prepareSessionEntryReplacementPublication(
              { ...committed, ...change.identity },
              writer,
              { postimages: change.postimages, ...(full ? { captureFullFacts: true } : {}) },
            );
            expect(sql.counts).toEqual(before);
            return result;
          };
          const expectView = (
            view: ReturnType<typeof publish>,
            ids: string[],
            members: string[],
            hasBoard: boolean,
          ) => {
            const current = view.current.get(key);
            expect(current).toMatchObject({
              participants: ids.map((id) => ({ identity: { type: "agent", id } })),
              participantCount: ids.length,
            });
            expect(view.projection?.get(key)).toMatchObject({
              membership: [key, null, members, expect.any(Object), "entry-postimage"],
              hasBoard,
            });
            return current;
          };
          const retained = publish(mutation, true);
          const current = expectView(retained, ["first"], ["first-member"], true);
          const skills = retained.fullEntries?.get(key)?.skillsSnapshot;
          expect(current?.lastRunError).toBe("updated");
          expect(current).not.toHaveProperty("skillsSnapshot");
          expect(skills?.prompt).toBe("private saved prompt");
          for (const field of ["resolvedSkills", "discoverySkills"]) {
            expect(skills).not.toHaveProperty(field);
          }
          expect(current).not.toHaveProperty("owner");
          expect(retained.projection?.get(key)).toMatchObject({
            activitySummaryWatermark: { generation: null, maxSeq: null },
          });

          recordSessionParticipant(scope, {
            identity: { type: "agent", id: "later" },
            promptedAt: 20,
          });
          writer.db
            .prepare("DELETE FROM session_members WHERE session_key = ?")
            .run(scope.sessionKey);
          writer.db.prepare("DELETE FROM board_tabs WHERE session_key = ?").run(scope.sessionKey);
          const participantsBeforeRead = sql.counts.participants;
          const changed = readSnapshot(writer);
          expect(sql.counts.participants).toBe(participantsBeforeRead);
          const changedMutation = patchEntry(writer, changed, {
            lastRunError: "after side-table writes",
          });
          if (!changedMutation.identity) {
            throw new Error("Missing changed patch identity");
          }
          const refreshed = publish(changedMutation, true);
          expectView(refreshed, ["first", "later"], [], false);

          const beforeAppend = readSnapshot(writer);
          const beforeAppendEntry = beforeAppend[0]?.entry;
          if (!beforeAppendEntry) {
            throw new Error("Missing entry before transcript append");
          }
          expectAppend(
            { ...scope, sessionId: beforeAppendEntry.sessionId },
            "append after entry selection",
          );
          const windowsBeforePatch = sql.counts.windows;
          const appendedMutation = patchEntry(writer, beforeAppend, {
            lastRunError: "after transcript append",
          });
          expect(sql.counts.windows).toBe(windowsBeforePatch);
          const { window: appendedWindow, transcriptWatermark: appendedWatermark } =
            appendedMutation.postimages?.get(key) ?? {};
          // The session header precedes the first appended message.
          expect(appendedWatermark).toEqual({ generation: expect.any(String), maxSeq: 1 });
          const appendedPublication = publish(appendedMutation);
          expect(appendedPublication.projection?.get(key)?.activitySummaryWatermark).toEqual(
            appendedWatermark,
          );
          expect(appendedWindow?.transcript_observed_at).toBe(
            appendedWindow?.transcript_updated_at,
          );
          expect(readObservation(writer, beforeAppendEntry.sessionId)).toEqual({
            transcript_observed_at: appendedWindow?.transcript_observed_at,
            transcript_updated_at: appendedWindow?.transcript_updated_at,
          });

          addSideTables("replacement-member");
          const beforeReset = readSnapshot(writer);
          const replacement = patchEntry(writer, beforeReset, {
            sessionId: "replacement-postimage",
            updatedAt: 30,
          });
          const replacementPostimage = replacement.postimages?.get(key);
          expect(replacementPostimage?.entry).toMatchObject({
            sessionId: "replacement-postimage",
            participantCount: 2,
          });
          expect(replacementPostimage?.sideTables).toEqual({
            memberIdsJson: "[]",
            hasBoard: true,
          });
          expect(readExactSessionEntryRow(writer, key)?.entry).toEqual(replacementPostimage?.entry);
        }, scope);
      } finally {
        sql.restore();
      }
    }),
);
