import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "../../state/openclaw-agent-board-schema.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readSessionEntrySelectionSnapshot,
  readLifecycleTargetSnapshot,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import type { SessionEntry } from "./types.js";

it("skips unchanged entry and snapshot writes while retaining current transcript observation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:entry-noop" };
    const database = openOpenClawAgentDatabase(scope);
    const skillsSnapshot = { prompt: "saved prompt", skills: [] };
    runOpenClawAgentWriteTransaction(
      (writer) =>
        writeSessionEntry(writer, scope.sessionKey, {
          sessionId: "entry-noop",
          updatedAt: 10,
          skillsSnapshot,
        }),
      scope,
    );
    const assertCommitAllowed = vi.fn();
    const patch = async (fields: Partial<SessionEntry>) =>
      runOpenClawAgentWriteTransaction((writer) => {
        const fresh = readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true);
        const current = fresh[0]?.entry;
        if (!current) {
          throw new Error("Missing entry before patch");
        }
        return writeSessionEntryPatchInDatabase(writer, {
          sessionKey: scope.sessionKey,
          fresh,
          writeBase: current,
          next: { ...current, ...fields },
          options: { assertCommitAllowed },
        }).entry;
      }, scope);
    // Settle the initial transcript observation before measuring unchanged rows.
    await patch({});
    const sql = trackSqliteStatementExecutions(
      database.db,
      ["nodes", "windows", "snapshots"],
      (query) => {
        const table = /^(?:insert into|update|delete from) "([^"]+)"/iu.exec(query)?.[1];
        return table === "session_nodes"
          ? "nodes"
          : table === "session_windows"
            ? "windows"
            : table === "session_entry_snapshots"
              ? "snapshots"
              : null;
      },
    );
    try {
      assertCommitAllowed.mockClear();
      await expect(
        patch({ skillsSnapshot: structuredClone(skillsSnapshot) }),
      ).resolves.toMatchObject({
        updatedAt: 10,
        skillsSnapshot,
      });
      expect(sql.counts).toEqual({ nodes: 0, windows: 0, snapshots: 0 });
      expect(assertCommitAllowed).toHaveBeenCalled();

      await patch({
        lastRunError: "retained error",
        skillsSnapshot: structuredClone(skillsSnapshot),
      });
      expect(sql.counts).toEqual({ nodes: 1, windows: 0, snapshots: 0 });
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
        lastRunError: "retained error",
        skillsSnapshot,
      });

      expect(
        appendTranscriptMessageSync(
          { ...scope, sessionId: "entry-noop" },
          { message: { role: "user", content: "new transcript content" } },
        ).ok,
      ).toBe(true);
      const before = { ...sql.counts };
      const watermark = () =>
        database.db
          .prepare(
            "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
          )
          .get("entry-noop");
      const unobserved = watermark();
      expect(unobserved?.transcript_observed_at).not.toBe(unobserved?.transcript_updated_at);
      await patch({ skillsSnapshot: structuredClone(skillsSnapshot) });
      expect(sql.counts).toEqual({ ...before, windows: before.windows + 1 });
      const observed = watermark();
      expect(observed?.transcript_observed_at).toBe(observed?.transcript_updated_at);
      const settled = { ...sql.counts };
      await patch({});
      expect(sql.counts).toEqual(settled);
    } finally {
      sql.restore();
    }
  });
});

it.each(["entry", "target"] as const)(
  "publishes exact %s patch postimages without rereading written facts",
  async (selection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:entry-postimage" };
      const database = openOpenClawAgentDatabase(scope);
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
      runOpenClawAgentWriteTransaction(
        (writer) =>
          writeSessionEntry(writer, scope.sessionKey, {
            sessionId: "entry-postimage",
            updatedAt: 10,
            skillsSnapshot: { prompt: "private saved prompt", skills: [] },
          }),
        scope,
      );
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
        database.db,
        ["participants", "windows", "metadata"],
        (query) =>
          /^select\b.*\bfrom "session_participants"/iu.test(query)
            ? "participants"
            : query.includes('from "session_windows" where "session_id" =')
              ? "windows"
              : query.includes('as "member_ids_json"')
                ? "metadata"
                : null,
      );
      try {
        runOpenClawAgentWriteTransaction((writer) => {
          const fresh = readSnapshot(writer);
          const original = fresh[0]?.entry;
          if (!original) {
            throw new Error("Missing seeded entry");
          }
          const mutation = writeSessionEntryPatchInDatabase(writer, {
            sessionKey: scope.sessionKey,
            fresh,
            writeBase: original,
            next: {
              ...original,
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
            },
            options: {},
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
          const before = { ...sql.counts };
          const retained = prepareSessionEntryReplacementPublication(committed, writer, {
            postimages: mutation.postimages,
            captureFullFacts: true,
          });
          expect(sql.counts).toEqual(before);
          expect(retained.current.get(scope.sessionKey)).toMatchObject({
            lastRunError: "updated",
            participants: [{ identity: { type: "agent", id: "first" } }],
            participantCount: 1,
          });
          expect(retained.current.get(scope.sessionKey)).not.toHaveProperty("skillsSnapshot");
          expect(retained.fullEntries?.get(scope.sessionKey)?.skillsSnapshot?.prompt).toBe(
            "private saved prompt",
          );
          expect(retained.fullEntries?.get(scope.sessionKey)?.skillsSnapshot).not.toHaveProperty(
            "resolvedSkills",
          );
          expect(retained.fullEntries?.get(scope.sessionKey)?.skillsSnapshot).not.toHaveProperty(
            "discoverySkills",
          );
          expect(retained.current.get(scope.sessionKey)).not.toHaveProperty("owner");
          expect(retained.projection?.get(scope.sessionKey)).toMatchObject({
            membership: [
              scope.sessionKey,
              null,
              ["first-member"],
              expect.any(Object),
              "entry-postimage",
            ],
            hasBoard: true,
          });

          recordSessionParticipant(scope, {
            identity: { type: "agent", id: "later" },
            promptedAt: 20,
          });
          writer.db
            .prepare("DELETE FROM session_members WHERE session_key = ?")
            .run(scope.sessionKey);
          writer.db.prepare("DELETE FROM board_tabs WHERE session_key = ?").run(scope.sessionKey);
          const changed = readSnapshot(writer);
          const changedEntry = changed[0]?.entry;
          if (!changedEntry) {
            throw new Error("Missing entry after participant and membership writes");
          }
          const changedMutation = writeSessionEntryPatchInDatabase(writer, {
            sessionKey: scope.sessionKey,
            fresh: changed,
            writeBase: changedEntry,
            next: { ...changedEntry, lastRunError: "after side-table writes" },
            options: {},
          });
          if (!changedMutation.identity) {
            throw new Error("Missing changed patch identity");
          }
          const afterWrite = { ...sql.counts };
          const refreshed = prepareSessionEntryReplacementPublication(
            { ...committed, ...changedMutation.identity },
            writer,
            { postimages: changedMutation.postimages, captureFullFacts: true },
          );
          expect(sql.counts).toEqual(afterWrite);
          expect(refreshed.current.get(scope.sessionKey)).toMatchObject({
            participants: [
              { identity: { type: "agent", id: "first" } },
              { identity: { type: "agent", id: "later" } },
            ],
            participantCount: 2,
          });
          expect(refreshed.projection?.get(scope.sessionKey)).toMatchObject({
            membership: [scope.sessionKey, null, [], expect.any(Object), "entry-postimage"],
            hasBoard: false,
          });

          const beforeAppend = readSnapshot(writer);
          const beforeAppendEntry = beforeAppend[0]?.entry;
          if (!beforeAppendEntry) {
            throw new Error("Missing entry before transcript append");
          }
          expect(
            appendTranscriptMessageSync(
              { ...scope, sessionId: beforeAppendEntry.sessionId },
              { message: { role: "user", content: "append after entry selection" } },
            ).ok,
          ).toBe(true);
          const windowsBeforePatch = sql.counts.windows;
          const appendedMutation = writeSessionEntryPatchInDatabase(writer, {
            sessionKey: scope.sessionKey,
            fresh: beforeAppend,
            writeBase: beforeAppendEntry,
            next: { ...beforeAppendEntry, lastRunError: "after transcript append" },
            options: {},
          });
          expect(sql.counts.windows).toBe(windowsBeforePatch);
          const appendedWindow = appendedMutation.postimages?.get(scope.sessionKey)?.window;
          expect(appendedWindow?.transcript_observed_at).toBe(
            appendedWindow?.transcript_updated_at,
          );
          expect(
            writer.db
              .prepare(
                "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
              )
              .get(beforeAppendEntry.sessionId),
          ).toEqual({
            transcript_observed_at: appendedWindow?.transcript_observed_at,
            transcript_updated_at: appendedWindow?.transcript_updated_at,
          });

          addSideTables("replacement-member");
          const beforeReset = readSnapshot(writer);
          const beforeResetEntry = beforeReset[0]?.entry;
          if (!beforeResetEntry) {
            throw new Error("Missing entry before generation replacement");
          }
          const replacement = writeSessionEntryPatchInDatabase(writer, {
            sessionKey: scope.sessionKey,
            fresh: beforeReset,
            writeBase: beforeResetEntry,
            next: { ...beforeResetEntry, sessionId: "replacement-postimage", updatedAt: 30 },
            options: {},
          });
          const replacementPostimage = replacement.postimages?.get(scope.sessionKey);
          expect(replacementPostimage?.entry).toMatchObject({
            sessionId: "replacement-postimage",
            participantCount: 2,
          });
          expect(replacementPostimage?.sideTables).toEqual({
            memberIdsJson: "[]",
            hasBoard: true,
          });
          expect(readExactSessionEntryRow(writer, scope.sessionKey)?.entry).toEqual(
            replacementPostimage?.entry,
          );
        }, scope);
      } finally {
        sql.restore();
      }
    });
  },
);
