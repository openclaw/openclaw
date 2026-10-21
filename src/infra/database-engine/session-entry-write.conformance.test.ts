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
  return {
    source: "run",
    generatedAt,
    systemPrompt: { chars: 10, projectContextChars: 0, nonProjectContextChars: 10 },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 0, entries: [] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
  };
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
  const counts: Record<string, number> = {};
  const queries: Record<string, string[]> = {};
  return {
    counts,
    queries,
    capture<T>(name: string, run: () => T): T {
      if (!isPostgresSqlConnection(db)) {
        return run();
      }
      const statements: string[] = [];
      const query = db.query.bind(db);
      const spy = vi.spyOn(db, "query").mockImplementation(
        new Proxy(query, {
          apply(target, receiver, args) {
            statements.push(args[0]);
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      try {
        return run();
      } finally {
        spy.mockRestore();
        queries[name] = statements;
        counts[name] = statements.filter((sql) =>
          /\binsert into\s+"?(?:session_nodes|session_windows|session_entry_snapshots)"?|\bdelete from\s+"?session_entry_snapshots"?/iu.test(
            sql,
          ),
        ).length;
      }
    },
  };
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
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const options = { agentId: "main", path: database.path };
        const keys = [
          "agent:main:archive-a",
          ...Array.from({ length: 63 }, (_, index) => `agent:main:archive-middle-${index}`),
          "agent:main:archive-b",
        ];
        const untouched = "agent:main:archive-unselected";
        const skills = { prompt: "Retained archive instructions", skills: [] };
        const now = vi.spyOn(Date, "now").mockReturnValue(20);
        const recorder = tripRecorder(database.db);
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
        try {
          runOpenClawAgentWriteTransaction((owner) => {
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
          }, options);
          const initial = current();
          let sequential: ReturnType<typeof current> | undefined;
          const rollback = new Error("archive equivalence rollback");
          expect(() =>
            runOpenClawAgentWriteTransaction((owner) => {
              rawUnselectedWrite();
              for (const input of inputs()) {
                writeSessionEntry(owner, input.sessionKey, input.entry);
              }
              sequential = current();
              throw rollback;
            }, options),
          ).toThrow(rollback);
          expect(current()).toEqual(initial);

          readSessionEntryCache(database, { cache: true, projection: "list" });
          expect(() =>
            runOpenClawAgentWriteTransaction((owner) => {
              rawUnselectedWrite();
              writeArchivedSessionEntries(owner, inputs(), new Map());
              throw rollback;
            }, options),
          ).toThrow(rollback);
          expect(current()).toEqual(initial);
          expect(
            readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(
              keys[0]!,
            )?.archivedAt,
          ).toBeUndefined();

          const postimages: SessionEntryWritePostimages = new Map();
          const written = recorder.capture("archiveBatch", () =>
            runOpenClawAgentWriteTransaction((owner) => {
              rawUnselectedWrite();
              return writeArchivedSessionEntries(owner, inputs(), postimages);
            }, options),
          );
          expect(current()).toEqual(sequential);
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
            const state = persisted(database.db, key, read(key).entry.sessionId);
            const postimage = postimages.get(key);
            expect(postimage).toBeDefined();
            expect(state.window).toMatchObject(postimage!.window);
            expect(postimage?.entry.skillsSnapshot).toEqual(skills);
          }
          expect(
            readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(
              untouched,
            )?.label,
          ).toBe("untracked update before archive");
          if (engine === "postgres") {
            expect(recorder.counts.archiveBatch).toBe(3);
          }
        } finally {
          now.mockRestore();
        }
      }));

    it("keeps batched empty, hot, cold, and changed transcript versions equivalent", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const options = { agentId: "main", path: database.path };
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
        const now = vi.spyOn(Date, "now").mockReturnValue(20);
        const read = () => {
          const batch = readTranscriptContextVersionsInTransaction(database, ids);
          expect(batch).toEqual(
            ids.map((id) => readTranscriptContextVersionInTransaction(database, id)),
          );
          return batch;
        };
        try {
          runOpenClawAgentWriteTransaction((owner) => {
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
          }, options);
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
            runOpenClawAgentWriteTransaction((owner) => {
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
            }, options),
          ).toThrow(rollback);
          expect(read()).toEqual(before);
        } finally {
          now.mockRestore();
        }
      }));

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
        return withEngineStoreAdmission(() => recorder.capture(name, () => f.mutate(command)));
      };
      const patch = (name: string, fields: Partial<SessionEntry>) =>
        withEngineStoreAdmission(() =>
          recorder.capture(name, () =>
            f.patchEntry({
              selection: { kind: "entry", sessionKey: f.target.sessionKey, exact: true },
              sessionKey: f.target.sessionKey,
              operation: { kind: "fields", patch: fields },
              operationLabel: "session-entry.patch",
              validateCanonicalKeys: false,
              preserveActivity: true,
            }),
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
            participants:
              engine === "sqlite"
                ? [untimestampedParticipant, ...timestampedParticipants]
                : [...timestampedParticipants, untimestampedParticipant],
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
        expect(accepted.node).toMatchObject({
          updated_at: 20,
          snapshot_revision: 1,
        });
        expect(accepted.window).toMatchObject({ updated_at: 20, started_at: 20 });
        expect(read().entry).toMatchObject({ startedAt: 20 });
        expect(accepted.snapshots).toEqual(initial.snapshots);

        const prompt = report(20);
        expect(await execute("completeTurn", completion("final", 12, prompt))).toMatchObject({
          kind: "committed",
        });
        const completed = state();
        expect(completed.node).toMatchObject({ snapshot_revision: 2 });
        expect(completed.window).toEqual(accepted.window);
        expect(completed.snapshots).toEqual(snapshotRows(initialSkills, prompt));
        expect(read().entry).toMatchObject({
          inputTokens: 12,
          outputTokens: 4,
          systemPromptReport: prompt,
        });

        const changedSkills = { prompt: "Changed instructions", skills: [] };
        patch("entryPatch", { label: "Patched label", skillsSnapshot: changedSkills });
        expect(state()).toMatchObject({
          node: { label: "Patched label", snapshot_revision: 3 },
          window: completed.window,
          snapshots: snapshotRows(changedSkills, prompt),
        });
        patch("nodeOnly", { label: "Node only" });
        expect(state()).toMatchObject({
          node: { label: "Node only", snapshot_revision: 3 },
          window: completed.window,
          snapshots: snapshotRows(changedSkills, prompt),
        });
        const finalSkills = { prompt: "Only cold instructions changed", skills: [] };
        patch("snapshotOnly", { skillsSnapshot: finalSkills });
        const stable = state();
        expect(stable).toMatchObject({
          node: { label: "Node only", snapshot_revision: 4 },
          window: completed.window,
          snapshots: snapshotRows(finalSkills, prompt),
        });
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
        if (engine === "postgres") {
          for (const [name, queries] of Object.entries(recorder.queries)) {
            expect(
              queries.filter((sql) => /^BEGIN\b/iu.test(sql)),
              name,
            ).toHaveLength(1);
            expect(
              queries.filter((sql) => /pg_advisory_xact_lock/iu.test(sql)),
              name,
            ).toHaveLength(1);
            expect(
              queries.filter((sql) => /^COMMIT\b/iu.test(sql)),
              name,
            ).toHaveLength(name === "rollback" || name === "revokedGrant" ? 0 : 1);
          }
          expect(recorder.counts).toEqual({
            coldPatch: 1,
            acceptInput: 1,
            completeTurn: 1,
            entryPatch: 1,
            nodeOnly: 1,
            snapshotOnly: 1,
            noOp: 0,
            rollback: 1,
            revokedGrant: 1,
          });
        }
      } finally {
        now.mockRestore();
        f.close();
      }
    });

    it("binds interleaved snapshot shapes and preserves legacy provenance when its column is omitted", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const recorder = tripRecorder(database.db);
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
        const write = (name: string, key: string, entry: SessionEntry) =>
          recorder.capture(name, () =>
            runSqliteImmediateTransactionSync(database.db, () =>
              writeSessionEntry(database, key, entry),
            ),
          );
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
        write("seedA", keyA, a);
        write("seedB", keyB, b);
        a = { ...a, label: "A1", skillsSnapshot: { prompt: "A1 instructions", skills: [] } };
        write("oneSnapshot", keyA, a);
        b = { ...b, label: "B1", skillsSnapshot: { prompt: "B1 instructions", skills: [] } };
        write("twoSnapshots", keyB, b);
        a = { ...a, label: "A2", skillsSnapshot: { prompt: "A2 instructions", skills: [] } };
        write("oneSnapshotAgain", keyA, a);
        expect(stateA()).toMatchObject({
          node: { label: "A2", snapshot_revision: 3 },
          snapshots: snapshotRows(a.skillsSnapshot),
        });
        const stableB = persisted(database.db, keyB, b.sessionId);
        expect(stableB).toMatchObject({
          node: { label: "B1", snapshot_revision: 3 },
          snapshots: snapshotRows(b.skillsSnapshot, b.systemPromptReport),
        });

        record(["a0", "a1"]);
        a = { ...a, lifecycleRevision: "a1", updatedAt: 20 };
        write("legacyWindow", keyA, a);
        const afterWindow = stateA();
        expect(JSON.parse(String(afterWindow.node?.legacy_acp_migration_json))).toEqual([
          source("a1"),
        ]);
        expect(afterWindow).toMatchObject({
          node: { snapshot_revision: 3 },
          window: { updated_at: 20 },
          snapshots: snapshotRows(a.skillsSnapshot),
        });
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
        expect(afterSnapshot).toMatchObject({
          node: { label: "A3", snapshot_revision: 4 },
          window: { updated_at: 30 },
          snapshots: snapshotRows(a.skillsSnapshot),
        });
        a = { ...a, label: "A4", skillsSnapshot: { prompt: "A4 instructions", skills: [] } };
        write("ordinarySnapshot", keyA, a);
        expect(stateA()).toMatchObject({
          node: {
            label: "A4",
            snapshot_revision: 5,
            legacy_acp_migration_json: afterSnapshot.node?.legacy_acp_migration_json,
          },
          window: afterSnapshot.window,
          snapshots: snapshotRows(a.skillsSnapshot),
        });
        expect(persisted(database.db, keyB, b.sessionId)).toEqual(stableB);
        if (engine === "postgres") {
          expect(recorder.counts).toEqual({
            seedA: 2,
            seedB: 2,
            oneSnapshot: 1,
            twoSnapshots: 1,
            oneSnapshotAgain: 1,
            legacyWindow: 1,
            ordinaryWindow: 1,
            legacySnapshot: 1,
            ordinarySnapshot: 1,
          });
        }
      }));

    it("creates foreign-key children after their node and preserves snapshot revisions, deletion, and window ownership", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const recorder = tripRecorder(database.db);
        const write = (name: string, key: string, entry: SessionEntry) =>
          recorder.capture(name, () =>
            runSqliteImmediateTransactionSync(database.db, () =>
              writeSessionEntry(database, key, entry),
            ),
          );
        const plainKey = "agent:main:entry-new-window";
        write("newNodeWindow", plainKey, { sessionId: "entry-new-window", updatedAt: 10 });
        expect(persisted(database.db, plainKey, "entry-new-window")).toMatchObject({
          node: { current_session_id: "entry-new-window", snapshot_revision: 0 },
          window: { session_key: plainKey },
          snapshots: [],
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
        write("newNodeSnapshots", key, entry);
        const initial = persisted(database.db, key, entry.sessionId);
        expect(initial).toMatchObject({
          node: { label: "New node", snapshot_revision: 2 },
          window: { session_key: key },
          snapshots: snapshotRows(skills, prompt),
        });
        const changedSkills = { prompt: "One changed snapshot", skills: [] };
        const changed = { ...entry, label: "Changed node", skillsSnapshot: changedSkills };
        write("existingNodeSnapshots", key, changed);
        const updated = persisted(database.db, key, entry.sessionId);
        expect(updated).toMatchObject({
          node: { label: "Changed node", snapshot_revision: 3 },
          window: initial.window,
          snapshots: snapshotRows(changedSkills, prompt),
        });
        write("unchanged", key, changed);
        expect(persisted(database.db, key, entry.sessionId)).toEqual(updated);

        write("removeOne", key, { ...changed, skillsSnapshot: undefined });
        expect(persisted(database.db, key, entry.sessionId)).toMatchObject({
          node: { snapshot_revision: 4 },
          window: initial.window,
          snapshots: snapshotRows(undefined, prompt),
        });
        write("removeAll", key, {
          ...changed,
          skillsSnapshot: undefined,
          systemPromptReport: undefined,
        });
        expect(persisted(database.db, key, entry.sessionId)).toMatchObject({
          node: { snapshot_revision: 5 },
          window: initial.window,
          snapshots: [],
        });

        const otherKey = "agent:main:entry-window-owner";
        write("claimOwner", otherKey, { sessionId: entry.sessionId, updatedAt: 20 });
        write("retainOwner", key, { sessionId: entry.sessionId, updatedAt: 30, status: "done" });
        expect(persisted(database.db, key, entry.sessionId)).toMatchObject({
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
        expect(persisted(database.db, refusedKey, "entry-refused-new")).toEqual({
          node: undefined,
          window: undefined,
          snapshots: [],
        });
        if (engine === "postgres") {
          expect(
            recorder.queries.removeOne!.filter((sql) =>
              /delete from\s+"?session_entry_snapshots/iu.test(sql),
            ),
          ).toHaveLength(1);
          expect(
            recorder.queries.removeAll!.filter((sql) =>
              /delete from\s+"?session_entry_snapshots/iu.test(sql),
            ),
          ).toHaveLength(1);
          expect({
            newNodeWindow: recorder.counts.newNodeWindow,
            newNodeSnapshots: recorder.counts.newNodeSnapshots,
            existingNodeSnapshots: recorder.counts.existingNodeSnapshots,
            unchanged: recorder.counts.unchanged,
            claimOwner: recorder.counts.claimOwner,
            retainOwner: recorder.counts.retainOwner,
          }).toEqual({
            newNodeWindow: 1,
            newNodeSnapshots: 2,
            existingNodeSnapshots: 1,
            unchanged: 0,
            claimOwner: 1,
            retainOwner: 1,
          });
        }
      }));
  },
);
