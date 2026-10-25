import { assert, expect, it } from "vitest";
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
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
import { writeSessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readSessionEntrySelectionSnapshot,
  readLifecycleTargetSnapshot,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import type { SessionEntry } from "./types.js";

function entryFixture(state: OpenClawTestState, sessionId: string) {
  const key = `agent:main:${sessionId}`;
  const scope = { agentId: "main", env: state.env, sessionKey: key };
  const database = openOpenClawAgentDatabase(scope);
  const transact = <T>(run: (writer: typeof database) => T) =>
    runOpenClawAgentWriteTransaction(run, scope);
  const write = (fields: Partial<SessionEntry>) =>
    transact((writer) => writeSessionEntry(writer, key, { sessionId, updatedAt: 10, ...fields }));
  return { key, scope, database, write, transact };
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
  assert(current, "Missing entry before patch");
  return writeSessionEntryPatchInDatabase(writer, {
    sessionKey: current.sessionKey,
    fresh,
    writeBase: current.entry,
    next: { ...current.entry, ...fields },
    options,
  });
}

it("clears cached owners without removing participant metadata", () =>
  withEntryFixture("cache-metadata", ({ scope, database, write, transact }) => {
    const expectAbsentMetadata = (entry: SessionEntry | undefined) => {
      expect(entry).toMatchObject({ sessionId: "cache-metadata" });
      for (const field of ["owner", "participants", "participantCount"]) {
        expect(entry).not.toHaveProperty(field);
      }
    };
    const current = () =>
      readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db))?.get(
        scope.sessionKey,
      );
    const owner: NonNullable<SessionEntry["owner"]> = {
      actor: { type: "human", id: "cache-owner" },
    };
    const participant = { identity: { type: "agent" as const, id: "cache-participant" } };
    const participantFacts = { participants: [participant], participantCount: 1 };
    const assignOwner = (assignment: typeof owner | undefined) =>
      transact((writer) => replaceSessionOwnerInTransaction(writer, scope.sessionKey, assignment));
    write({});
    readSessionEntryCache(database, { cache: true, projection: "list" });
    expectAbsentMetadata(current());

    expect(assignOwner(owner)).toBe(true);
    readSessionEntryCache(database, { cache: true, projection: "list" });
    expect(current()?.owner).toEqual(owner);
    expect(assignOwner(undefined)).toBe(true);
    expectAbsentMetadata(current());

    expect(assignOwner(owner)).toBe(true);
    expect(recordSessionParticipant(scope, { ...participant, promptedAt: 10 })).toBe("inserted");
    expect(current()).toMatchObject({ owner, ...participantFacts });
    expect(assignOwner(undefined)).toBe(true);
    expect(current()).not.toHaveProperty("owner");
    expect(current()).toMatchObject(participantFacts);
  }));

it("authorizes unchanged patches and retains current transcript observation", () =>
  withEntryFixture("entry-noop", async ({ scope, database, write, transact }) => {
    const skillsSnapshot = { prompt: "saved prompt", skills: [] };
    write({ skillsSnapshot });
    let allowed = true;
    const assertCommitAllowed = () => {
      if (!allowed) {
        throw new Error("patch authority revoked");
      }
    };
    const savedPatch = () => ({ skillsSnapshot: structuredClone(skillsSnapshot) });
    const patch = async (fields: Partial<SessionEntry>) =>
      transact(
        (writer) =>
          patchEntry(
            writer,
            readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true),
            fields,
            { assertCommitAllowed },
          ).entry,
      );
    allowed = false;
    await expect(patch(savedPatch())).rejects.toThrow("patch authority revoked");
    allowed = true;
    await expect(patch(savedPatch())).resolves.toMatchObject({ updatedAt: 10, skillsSnapshot });

    expectAppend({ ...scope, sessionId: "entry-noop" }, "new transcript content");
    const watermark = () => readObservation(database, "entry-noop");
    const unobserved = watermark();
    expect(unobserved?.transcript_observed_at).not.toBe(unobserved?.transcript_updated_at);
    await patch(savedPatch());
    const observed = watermark();
    expect(observed?.transcript_observed_at).toBe(observed?.transcript_updated_at);
    await patch({});
    expect(watermark()).toEqual(observed);
  }));

it.each(["entry", "target"] as const)(
  "captures current %s side-table and transcript facts across patches and replacement",
  (selection) =>
    withEntryFixture("entry-postimage", ({ key, scope, database, write, transact }) => {
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
      write({});
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
      transact((writer) => {
        ensureOpenClawAgentBoardSchemaInTransaction(writer.db);
        addSideTables("first-member");
      });
      transact((writer) => {
        const expectView = (
          change: ReturnType<typeof patchEntry>,
          ids: string[],
          members: string[],
          hasBoard: boolean,
        ) => {
          expect(change.postimages?.get(key)).toMatchObject({
            entry: {
              participants: ids.map((id) => ({ identity: { type: "agent", id } })),
              participantCount: ids.length,
            },
            sideTables: { memberIdsJson: JSON.stringify(members), hasBoard },
          });
        };
        const mutation = patchEntry(writer, readSnapshot(writer), {
          lastRunError: "updated",
          owner: { actor: { type: "human", id: "unpersisted-owner" } },
          skillsSnapshot: {
            prompt: "saved prompt",
            skills: [],
            resolvedSkills: [],
            discoverySkills: [],
          },
        });
        expect(mutation.entry).not.toHaveProperty("owner");
        expect(mutation.postimages?.get(key)?.entry.skillsSnapshot).toEqual({
          prompt: "saved prompt",
          skills: [],
        });
        expectView(mutation, ["first"], ["first-member"], true);
        expect(mutation.postimages?.get(key)?.transcriptWatermark).toEqual({
          generation: null,
          maxSeq: null,
        });

        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "later" },
          promptedAt: 20,
        });
        writer.db
          .prepare("DELETE FROM session_members WHERE session_key = ?")
          .run(scope.sessionKey);
        writer.db.prepare("DELETE FROM board_tabs WHERE session_key = ?").run(scope.sessionKey);
        const changedMutation = patchEntry(writer, readSnapshot(writer), {
          lastRunError: "after side-table writes",
        });
        expectView(changedMutation, ["first", "later"], [], false);

        const beforeAppend = readSnapshot(writer);
        const beforeAppendEntry = beforeAppend[0]?.entry;
        assert(beforeAppendEntry, "Missing entry before transcript append");
        expectAppend(
          { ...scope, sessionId: beforeAppendEntry.sessionId },
          "append after entry selection",
        );
        const appendedMutation = patchEntry(writer, beforeAppend, {
          lastRunError: "after transcript append",
        });
        const { window: appendedWindow, transcriptWatermark: appendedWatermark } =
          appendedMutation.postimages?.get(key) ?? {};
        // The session header precedes the first appended message.
        expect(appendedWatermark).toEqual({ generation: expect.any(String), maxSeq: 1 });
        expect(appendedWindow?.transcript_observed_at).toBe(appendedWindow?.transcript_updated_at);
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
      });
    }),
);
