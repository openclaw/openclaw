import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { recordLegacyAcpMigrationSources } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { readSessionEntryCache } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeArchivedSessionEntries,
  writeSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorWorkerFixture,
  type Mutation,
} from "../../config/sessions/session-actor-worker.test-support.js";
import type { SessionEntryWritePostimages } from "../../config/sessions/session-entry-write-postimage.js";
import { readTranscriptContextVersionsInTransaction } from "../../config/sessions/session-transcript-context-versions.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { promptReport } from "../../config/sessions/system-prompt-report.test-support.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { createSqliteWorkerTransferCollector } from "../sqlite-worker-transfer.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function report(generatedAt: number): NonNullable<SessionEntry["systemPromptReport"]> {
  return promptReport(generatedAt, 10, 0);
}

function persisted(db: EngineConnection, sessionKey: string, sessionId: string) {
  return {
    node: db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(sessionKey),
    window: db.prepare("SELECT * FROM session_windows WHERE session_id = ?").get(sessionId),
    snapshots: db
      .prepare(
        "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
      )
      .all(sessionKey),
  };
}

function tripRecorder(db: EngineConnection) {
  const queries: Record<string, string[]> = {};
  const isEntryWrite = (sql: string) =>
    /\binsert into\s+"?(?:session_nodes|session_windows|session_entry_snapshots)"?|\bdelete from\s+"?session_entry_snapshots"?/iu.test(
      sql,
    );
  return {
    queries,
    expectQueries(name: string, pattern: RegExp, count: number) {
      if (isPostgresSqlConnection(db)) {
        expect(
          queries[name]!.filter((sql) => pattern.test(sql)),
          name,
        ).toHaveLength(count);
      }
    },
    capture<T>(name: string, run: () => T, writes?: number | null): T {
      if (!isPostgresSqlConnection(db)) {
        return run();
      }
      const statements: string[] = [];
      const query = db.query.bind(db);
      const spy = vi.spyOn(db, "query").mockImplementation((sql, parameters) => {
        statements.push(sql);
        return query(sql, parameters);
      });
      try {
        return run();
      } finally {
        spy.mockRestore();
        queries[name] = statements;
        if (writes != null) {
          expect(statements.filter(isEntryWrite), name).toHaveLength(writes);
        }
      }
    },
  };
}

function withEntryDatabase(
  run: (fixture: ReturnType<typeof entryDatabase>) => void,
  freezeTime = false,
) {
  return withEngineStoreAdmission(() => {
    const fixture = entryDatabase();
    const now = freezeTime ? vi.spyOn(Date, "now").mockReturnValue(20) : undefined;
    try {
      run(fixture);
    } finally {
      now?.mockRestore();
    }
  });
}

function entryDatabase() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const recorder = tripRecorder(database.db);
  return {
    database,
    recorder,
    transaction: <T>(run: (owner: typeof database) => T) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path }),
    write: (name: string, key: string, entry: SessionEntry, writes: number | null = 1) =>
      recorder.capture(
        name,
        () =>
          runSqliteImmediateTransactionSync(database.db, () =>
            writeSessionEntry(database, key, entry),
          ),
        writes,
      ),
    state: (key: string, id: string) => persisted(database.db, key, id),
  };
}

function expectState(
  state: ReturnType<typeof persisted>,
  revision: number,
  skills?: SessionEntry["skillsSnapshot"],
  prompt?: SessionEntry["systemPromptReport"],
) {
  expect(state.node).toMatchObject({ snapshot_revision: revision });
  expect(state.snapshots).toEqual(snapshotRows(skills, prompt));
  return expect(state);
}

function snapshotRows(
  skills: SessionEntry["skillsSnapshot"],
  prompt?: SessionEntry["systemPromptReport"],
) {
  return [
    ...(skills ? [{ field: "skillsSnapshot", value_json: JSON.stringify(skills) }] : []),
    ...(prompt ? [{ field: "systemPromptReport", value_json: JSON.stringify(prompt) }] : []),
  ];
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s prepared entry writes",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("batches archive entries with exact shared-window, rollback, and cache outcomes", () =>
      withEntryDatabase(({ database, recorder, transaction }) => {
        const keys = [
          "agent:main:archive-a",
          ...Array.from({ length: 63 }, (_, index) => `agent:main:archive-middle-${index}`),
          "agent:main:archive-b",
        ];
        const untouched = "agent:main:archive-unselected";
        const skills = { prompt: "Retained archive instructions", skills: [] };
        const read = (key: string) => {
          const row = readExactSessionEntryRow(database, key, "full", "canonical", true);
          if (!row) {
            throw new Error("Missing archive equivalence fixture row");
          }
          return row;
        };
        const current = () =>
          [...keys, untouched].map((key) => {
            const entry = read(key).entry;
            return persisted(database.db, key, entry.sessionId);
          });
        const inputs = () =>
          [...keys, keys[1]!].map((sessionKey, index) => {
            const previous = read(sessionKey);
            return {
              sessionKey,
              previous,
              entry: {
                ...previous.entry,
                archivedAt: 30,
                archiveReason: "age-retention" as const,
                ...(index === 0 ? { hookExternalContentSource: "gmail" as const } : {}),
                ...(sessionKey === keys[1] ? { label: index === 1 ? "superseded" : "final" } : {}),
              },
            };
          });
        const rawUnselectedWrite = () => {
          const entry = { ...read(untouched).entry, label: "untracked update before archive" };
          database.db
            .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
            .run(JSON.stringify(entry), entry.label, untouched);
        };
        transaction((owner) => {
          for (const [index, key] of [...keys, untouched].entries()) {
            writeSessionEntry(owner, key, {
              sessionId: index === 0 || index === 64 ? "archive-shared" : `archive-${index}`,
              updatedAt: 10,
              skillsSnapshot: skills,
            });
          }
          appendTranscriptEventsInTransaction(
            owner,
            { agentId: "main", sessionKey: keys.at(-1)!, sessionId: "archive-shared" },
            [{ type: "session", id: "archive-shared", version: 3 }],
          );
        });
        const initial = current();
        const rollback = new Error("archive equivalence rollback");
        readSessionEntryCache(database, { cache: true, projection: "list" });
        expect(() =>
          transaction((owner) => {
            rawUnselectedWrite();
            writeArchivedSessionEntries(owner, inputs(), new Map());
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(current()).toEqual(initial);
        expect(
          readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(keys[0]!)
            ?.archivedAt,
        ).toBeUndefined();

        const postimages: SessionEntryWritePostimages = new Map();
        const written = recorder.capture(
          "archiveBatch",
          () =>
            transaction((owner) => {
              rawUnselectedWrite();
              return writeArchivedSessionEntries(owner, inputs(), postimages);
            }),
          3,
        );
        expect(written.map((entry) => entry.archivedAt)).toEqual(
          Array.from({ length: 66 }, () => 30),
        );
        expect([written[1]?.label, written.at(-1)?.label]).toEqual(["final", "final"]);
        expect(current()[0]).toMatchObject({
          node: { archived_at: 30, snapshot_revision: 1 },
          snapshots: snapshotRows(skills),
          window: { session_key: keys.at(-1), hook_external_content_source: "gmail" },
        });
        for (const key of keys) {
          const entry = read(key).entry;
          const state = persisted(database.db, key, entry.sessionId);
          const postimage = postimages.get(key);
          expect(entry).toMatchObject({ archivedAt: 30, archiveReason: "age-retention" });
          expect(postimage).toBeDefined();
          expect(state.node).toMatchObject({ archived_at: 30, snapshot_revision: 1 });
          expect(state.snapshots).toEqual(snapshotRows(skills));
          expect(state.window).toMatchObject(postimage!.window);
          expect(postimage?.entry.skillsSnapshot).toEqual(skills);
        }
        expect(
          readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(
            untouched,
          )?.label,
        ).toBe("untracked update before archive");
      }, true));

    it("reads batched empty, hot, and cold transcript versions and rolls back changes", () =>
      withEntryDatabase(({ database, transaction }) => {
        const ids = [
          "version-absent",
          "version-empty",
          "version-hot",
          "version-cold",
          "version-hot",
        ];
        const scope = (sessionId: string) => ({
          agentId: "main",
          sessionKey: `agent:main:${sessionId}`,
          sessionId,
        });
        const read = () => readTranscriptContextVersionsInTransaction(database, ids);
        transaction((owner) => {
          for (const id of ids.slice(1, 4)) {
            writeSessionEntry(owner, scope(id).sessionKey, { sessionId: id, updatedAt: 10 });
          }
          appendTranscriptEventsInTransaction(owner, scope("version-hot"), [
            { type: "session", id: "version-hot", version: 3 },
            { type: "custom", customType: "version", data: { value: "first" } },
          ]);
          owner.db
            .prepare(
              "INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES (?, ?, ?)",
            )
            .run("version-cold", "cold-generation", 17);
          owner.db
            .prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?")
            .run(17, "version-cold");
          owner.db
            .prepare(`INSERT INTO session_transcript_cold_archives
              (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage, archive_blob)
              VALUES (?, ?, ?, ?, 10, 1, 1, 9, 17, 'file', NULL)`)
            .run("version-cold", "cold-generation", "version-cold.zst", "0".repeat(64));
        });
        const before = read();
        expect(before).toEqual([
          { rawSeq: null, generation: null, updatedAt: null },
          { rawSeq: null, generation: null, updatedAt: null },
          { rawSeq: 1, generation: expect.any(String), updatedAt: 20 },
          { rawSeq: 9, generation: "cold-generation", updatedAt: 17 },
          { rawSeq: 1, generation: expect.any(String), updatedAt: 20 },
        ]);
        const rollback = new Error("rollback changed transcript versions");
        expect(() =>
          transaction((owner) => {
            readTranscriptContextVersionInTransaction(owner, "version-hot");
            appendTranscriptEventsInTransaction(owner, scope("version-hot"), [
              { type: "custom", customType: "version", data: { value: "later" } },
            ]);
            owner.db
              .prepare(
                "UPDATE session_transcript_cold_archives SET last_seq = 11 WHERE session_id = ?",
              )
              .run("version-cold");
            owner.db
              .prepare(
                "UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?",
              )
              .run("cold-next", "version-cold");
            const changed = read();
            expect(changed[2]?.rawSeq).toBe(2);
            expect(changed[3]).toEqual({ rawSeq: 11, generation: "cold-next", updatedAt: 17 });
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(read()).toEqual(before);
      }, true));

    it("commits actor and patch entry pairs without extra writes or publishing a refused commit", async () => {
      const initialSkills = { prompt: "Initial instructions", skills: [] };
      const seed = withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const scope = {
          agentId: "main",
          storePath: database.path,
          sessionKey: "agent:main:entry-pairs",
          sessionId: "entry-pairs",
        };
        replaceSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          updatedAt: 10,
          label: "Initial label",
          displayName: "Stable display name",
          skillsSnapshot: initialSkills,
        });
        runSqliteImmediateTransactionSync(database.db, () =>
          appendTranscriptEventsInTransaction(database, scope, [
            {
              type: "session",
              id: scope.sessionId,
              version: 3,
              timestamp: new Date(10).toISOString(),
            },
          ]),
        );
        runSqliteImmediateTransactionSync(database.db, () => {
          const insert = database.db.prepare(
            "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at) VALUES (?, ?, ?, 1, ?)",
          );
          for (const [type, id, time] of [
            ["profile", "a", 20],
            ["agent", "a", 20],
            ["agent", "z", null],
          ] as const) {
            insert.run(scope.sessionKey, JSON.stringify({ type }), id, time);
          }
        });
        return { database, scope };
      });
      const f = createSessionActorWorkerFixture(seed, (options) =>
        withEngineStoreAdmission(() => openOpenClawAgentDatabase(options)),
      );
      const now = vi.spyOn(Date, "now").mockReturnValue(20);
      const recorder = tripRecorder(f.database.db);
      const state = () =>
        withEngineStoreAdmission(() =>
          persisted(f.database.db, f.scope.sessionKey, f.scope.sessionId),
        );
      const read = () => withEngineStoreAdmission(() => f.read());
      const execute = async (name: string, command: Mutation) => {
        await f.prepare(command);
        return withEngineStoreAdmission(() => recorder.capture(name, () => f.mutate(command), 1));
      };
      const patch = (name: string, fields: Partial<SessionEntry>) =>
        withEngineStoreAdmission(() =>
          recorder.capture(
            name,
            () =>
              f.patchEntry({
                selection: { kind: "entry", sessionKey: f.target.sessionKey, exact: true },
                sessionKey: f.target.sessionKey,
                operation: { kind: "fields", patch: fields },
                operationLabel: "session-entry.patch",
                validateCanonicalKeys: false,
                preserveActivity: true,
              }),
            name === "noOp" ? 0 : 1,
          ),
        );
      const completion = (
        name: string,
        inputTokens: number,
        prompt: NonNullable<SessionEntry["systemPromptReport"]>,
      ): Mutation => {
        const before = read();
        return {
          type: "session.actor.completeTurn",
          input: {
            target: f.target,
            commandId: name,
            phaseId: "completion",
            expected: before.version,
            bookkeeping: {
              sessionId: f.scope.sessionId,
              lifecycleRevision: before.entry!.lifecycleRevision ?? null,
              writerRunId: before.entry!.activeWriterRunId,
              expectedState: buildRestartRecoveryExpectedState(before.entry!),
            },
            reducers: [
              {
                kind: "usage",
                updatedAt: before.entry!.updatedAt,
                update: {
                  usage: { input: inputTokens, output: 4 },
                  systemPromptReport: prompt,
                  modelSelection: {},
                  hasContextUpdate: false,
                  hasFreshContextSnapshot: false,
                  hasCurrentContextSnapshot: false,
                  preserveSessionModelState: true,
                  preserveUserFacingRunState: false,
                },
              },
            ],
          },
        };
      };
      try {
        let coldPatch: unknown;
        const transfer = createSqliteWorkerTransferCollector("patch", (value) => {
          coldPatch = value;
        });
        f.hooks.admit = (_stage, facts) => {
          if (isRecord(facts) && "transfer" in facts) {
            transfer.accept(facts.transfer);
          }
        };
        patch("coldPatch", { label: "Cold participant projection" });
        delete f.hooks.admit;
        if (engine === "postgres") {
          // BEGIN + eager lock, hydrated entry, node/window CTE, COMMIT.
          expect(recorder.queries.coldPatch).toHaveLength(4);
        }
        const initial = state();
        const before = read();
        const timestampedParticipants = [
          { identity: { type: "agent", id: "a" } },
          { identity: { type: "profile", id: "a" } },
        ];
        const untimestampedParticipant = { identity: { type: "agent", id: "z" } };
        expect(coldPatch).toMatchObject({
          entry: {
            participants: [untimestampedParticipant, ...timestampedParticipants],
          },
        });
        // Actor hydration has always normalized NULL timestamps first on both engines.
        expect(before.entry?.participants).toEqual([
          untimestampedParticipant,
          ...timestampedParticipants,
        ]);
        const acceptedOutcome = await execute("acceptInput", {
          type: "session.actor.acceptInput",
          input: {
            target: f.target,
            commandId: "input",
            phaseId: "turn",
            expectedState: buildRestartRecoveryExpectedState(before.entry!),
            lifecycle: { updatedAt: 20, startedAt: 20 },
            turn: {
              agentId: "main",
              sessionKey: f.scope.sessionKey,
              options: {
                expectedSessionId: f.scope.sessionId,
                sessionFile: f.scope.sessionKey,
                messages: [
                  {
                    eventId: "input",
                    message: { role: "user", content: "Question", timestamp: 20 },
                    now: 20,
                  },
                ],
              },
            },
          },
        });
        expect(acceptedOutcome.kind, JSON.stringify(acceptedOutcome)).toBe("committed");
        const accepted = state();
        expectState(accepted, 1, initialSkills).toMatchObject({
          node: { updated_at: 20 },
          window: { updated_at: 20, started_at: 20 },
        });
        expect(read().entry).toMatchObject({ startedAt: 20 });
        expect(accepted.snapshots).toEqual(initial.snapshots);

        const prompt = report(20);
        expect(await execute("completeTurn", completion("final", 12, prompt))).toMatchObject({
          kind: "committed",
        });
        const completed = state();
        expectState(completed, 2, initialSkills, prompt);
        expect(completed.window).toEqual(accepted.window);
        expect(read().entry).toMatchObject({
          inputTokens: 12,
          outputTokens: 4,
          systemPromptReport: prompt,
        });

        const changedSkills = { prompt: "Changed instructions", skills: [] };
        const finalSkills = { prompt: "Only cold instructions changed", skills: [] };
        const patches: [string, Partial<SessionEntry>, string, typeof changedSkills, number][] = [
          [
            "entryPatch",
            { label: "Patched label", skillsSnapshot: changedSkills },
            "Patched label",
            changedSkills,
            3,
          ],
          ["nodeOnly", { label: "Node only" }, "Node only", changedSkills, 3],
          ["snapshotOnly", { skillsSnapshot: finalSkills }, "Node only", finalSkills, 4],
        ];
        for (const [name, fields, label, skills, revision] of patches) {
          patch(name, fields);
          expectState(state(), revision, skills, prompt).toMatchObject({
            node: { label },
            window: completed.window,
          });
        }
        const stable = state();
        patch("noOp", { label: "Node only", skillsSnapshot: finalSkills });
        expect(state()).toEqual(stable);

        for (const refusal of ["rollback", "revokedGrant"] as const) {
          const beforeRefusal = read();
          if (refusal === "rollback") {
            f.hooks.withCommit = () => {
              throw new Error(refusal);
            };
          } else {
            f.hooks.admit = (stage) => {
              if (stage === "commit") {
                throw new Error(refusal);
              }
            };
          }
          expect(await execute(refusal, completion(refusal, 99, report(99)))).toMatchObject({
            kind: "rolled-back",
            error: { message: refusal },
          });
          delete f.hooks.withCommit;
          delete f.hooks.admit;
          expect(state()).toEqual(stable);
          expect(read().entry).toEqual(beforeRefusal.entry);
        }
        for (const name of Object.keys(recorder.queries)) {
          recorder.expectQueries(name, /^BEGIN\b/iu, 1);
          recorder.expectQueries(name, /pg_advisory_xact_lock/iu, 1);
          recorder.expectQueries(
            name,
            /^COMMIT\b/iu,
            name === "rollback" || name === "revokedGrant" ? 0 : 1,
          );
        }
      } finally {
        now.mockRestore();
        f.close();
      }
    });

    it("binds interleaved snapshot shapes and preserves legacy provenance when its column is omitted", () =>
      withEntryDatabase(({ database, write }) => {
        const keyA = "agent:main:entry-shape-a";
        const keyB = "agent:main:entry-shape-b";
        let a: SessionEntry = {
          sessionId: "entry-shape-a",
          lifecycleRevision: "a0",
          updatedAt: 10,
          displayName: "Shape A",
          label: "A0",
          skillsSnapshot: { prompt: "A0 instructions", skills: [] },
        };
        let b: SessionEntry = {
          sessionId: "entry-shape-b",
          updatedAt: 10,
          displayName: "Shape B",
          label: "B0",
          skillsSnapshot: { prompt: "B0 instructions", skills: [] },
          systemPromptReport: report(10),
        };
        const stateA = () => persisted(database.db, keyA, a.sessionId);
        const source = (lifecycleRevision: string) => ({
          sourcePath: "/synthetic/acp/cache.json",
          sourceSessionKey: keyA,
          sessionId: a.sessionId,
          lifecycleRevision,
          sourceSha256: "c".repeat(64),
          sourceSizeBytes: 1,
        });
        const record = (revisions: string[]) =>
          runSqliteImmediateTransactionSync(database.db, () =>
            recordLegacyAcpMigrationSources(database.db, keyA, revisions.map(source)),
          );
        write("seedA", keyA, a, 2);
        write("seedB", keyB, b, 2);
        a = { ...a, label: "A1", skillsSnapshot: { prompt: "A1 instructions", skills: [] } };
        write("oneSnapshot", keyA, a);
        b = { ...b, label: "B1", skillsSnapshot: { prompt: "B1 instructions", skills: [] } };
        write("twoSnapshots", keyB, b);
        a = { ...a, label: "A2", skillsSnapshot: { prompt: "A2 instructions", skills: [] } };
        write("oneSnapshotAgain", keyA, a);
        expectState(stateA(), 3, a.skillsSnapshot).toMatchObject({ node: { label: "A2" } });
        const stableB = persisted(database.db, keyB, b.sessionId);
        expectState(stableB, 3, b.skillsSnapshot, b.systemPromptReport).toMatchObject({
          node: { label: "B1" },
        });

        record(["a0", "a1"]);
        a = { ...a, lifecycleRevision: "a1", updatedAt: 20 };
        write("legacyWindow", keyA, a);
        const afterWindow = stateA();
        expect(JSON.parse(String(afterWindow.node?.legacy_acp_migration_json))).toEqual([
          source("a1"),
        ]);
        expectState(afterWindow, 3, a.skillsSnapshot).toMatchObject({ window: { updated_at: 20 } });
        a = { ...a, updatedAt: 30 };
        write("ordinaryWindow", keyA, a);
        expect(stateA().node?.legacy_acp_migration_json).toBe(
          afterWindow.node?.legacy_acp_migration_json,
        );

        record(["a2"]);
        a = {
          ...a,
          lifecycleRevision: "a2",
          label: "A3",
          skillsSnapshot: { prompt: "A3 instructions", skills: [] },
        };
        write("legacySnapshot", keyA, a);
        const afterSnapshot = stateA();
        expect(JSON.parse(String(afterSnapshot.node?.legacy_acp_migration_json))).toEqual([
          source("a2"),
        ]);
        expectState(afterSnapshot, 4, a.skillsSnapshot).toMatchObject({
          node: { label: "A3" },
          window: { updated_at: 30 },
        });
        a = { ...a, label: "A4", skillsSnapshot: { prompt: "A4 instructions", skills: [] } };
        write("ordinarySnapshot", keyA, a);
        expectState(stateA(), 5, a.skillsSnapshot).toMatchObject({
          node: {
            label: "A4",
            legacy_acp_migration_json: afterSnapshot.node?.legacy_acp_migration_json,
          },
          window: afterSnapshot.window,
        });
        expect(persisted(database.db, keyB, b.sessionId)).toEqual(stableB);
      }));

    it("creates foreign-key children after their node and preserves snapshot revisions, deletion, and window ownership", () =>
      withEntryDatabase(({ database, recorder, write, state }) => {
        const plainKey = "agent:main:entry-new-window";
        write("newNodeWindow", plainKey, { sessionId: "entry-new-window", updatedAt: 10 });
        expectState(state(plainKey, "entry-new-window"), 0).toMatchObject({
          node: { current_session_id: "entry-new-window" },
          window: { session_key: plainKey },
        });

        const key = "agent:main:entry-new-snapshots";
        const skills = { prompt: "New instructions", skills: [] };
        const prompt = report(10);
        const entry = {
          sessionId: "entry-new-snapshots",
          updatedAt: 10,
          label: "New node",
          displayName: "Stable cold display name",
          skillsSnapshot: skills,
          systemPromptReport: prompt,
        };
        const current = () => state(key, entry.sessionId);
        const changedSkills = { prompt: "One changed snapshot", skills: [] };
        const changed = { ...entry, label: "Changed node", skillsSnapshot: changedSkills };
        const withoutSkills = { ...changed, skillsSnapshot: undefined };
        const stages: [string, SessionEntry, number, number | null][] = [
          ["newNodeSnapshots", entry, 2, 2],
          ["existingNodeSnapshots", changed, 3, 1],
          ["unchanged", changed, 3, 0],
          ["removeOne", withoutSkills, 4, null],
          ["removeAll", { ...withoutSkills, systemPromptReport: undefined }, 5, null],
        ];
        let initialWindow: ReturnType<typeof persisted>["window"];
        let previous: ReturnType<typeof persisted> | undefined;
        for (const [name, value, revision, writes] of stages) {
          write(name, key, value, writes);
          const result = current();
          initialWindow ??= result.window;
          expectState(
            result,
            revision,
            value.skillsSnapshot,
            value.systemPromptReport,
          ).toMatchObject({ node: { label: value.label }, window: initialWindow });
          expect(result.window).toMatchObject({ session_key: key });
          if (name === "unchanged") {
            expect(result).toEqual(previous);
          }
          previous = result;
        }

        const otherKey = "agent:main:entry-window-owner";
        write("claimOwner", otherKey, { sessionId: entry.sessionId, updatedAt: 20 });
        write("retainOwner", key, { sessionId: entry.sessionId, updatedAt: 30, status: "done" });
        expect(current()).toMatchObject({
          node: { current_session_id: entry.sessionId, status: "done", snapshot_revision: 5 },
          window: { session_key: otherKey, created_at: 10, updated_at: 30, status: "done" },
        });

        const refusedKey = "agent:main:entry-refused-new";
        expect(() =>
          runSqliteImmediateTransactionSync(database.db, () => {
            writeSessionEntry(database, refusedKey, { ...entry, sessionId: "entry-refused-new" });
            throw new Error("rollback new node");
          }),
        ).toThrow("rollback new node");
        expect(state(refusedKey, "entry-refused-new")).toEqual({
          node: undefined,
          window: undefined,
          snapshots: [],
        });
        for (const name of ["removeOne", "removeAll"]) {
          recorder.expectQueries(name, /delete from\s+"?session_entry_snapshots/iu, 1);
        }
      }));
  },
);
