import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSessionCostUsageRefreshLock } from "../../infra/session-cost-usage-cache.sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  participantRecordsBySessionKey,
  projectSqliteSessionParticipants,
} from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipantFromWorker } from "./session-accessor.sqlite-participants.native.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("reads committed participant counts and ordering in the same and next turn without SQL", async () => {
  await withActor((f) => {
    f.read();
    const reads = trackSqliteStatementExecutions(
      f.database.db,
      ["participant", "hydration"],
      (sql) => {
        if (sql.includes('as "actor_participants"')) {
          return "hydration";
        }
        return /^select\b/iu.test(sql) && sql.includes('"session_participants"')
          ? "participant"
          : null;
      },
    );
    const record = (id: string, promptedAt: number) =>
      recordSessionParticipantFromWorker(f.database, f.scope, {
        identity: { type: "agent", id },
        promptedAt,
      });
    const participants = () =>
      participantRecordsBySessionKey(f.database.db, [f.target.sessionKey]).get(f.target.sessionKey);
    try {
      runSqliteImmediateTransactionSync(f.database.db, () => {
        expect(record("second", 20).value).toBe("inserted");
        expect(participants()).toMatchObject([
          {
            identity: { id: "second" },
            contributionCount: 1,
            firstPromptedAt: 20,
            lastPromptedAt: 20,
          },
        ]);
        expect(record("first", 10).value).toBe("inserted");
        expect(record("second", 5).value).toBe("updated");
        expect(participants()?.map((participant) => participant.identity.id)).toEqual([
          "second",
          "first",
        ]);
      });
      expect(f.read().participants).toEqual(participants());
      expect(participants()).toMatchObject([
        {
          identity: { id: "second" },
          contributionCount: 2,
          firstPromptedAt: 5,
          lastPromptedAt: 20,
        },
        {
          identity: { id: "first" },
          contributionCount: 1,
          firstPromptedAt: 10,
          lastPromptedAt: 10,
        },
      ]);
      runSqliteImmediateTransactionSync(f.database.db, () => record("second", 30));
      const next = f.read();
      expect(next.participants[0]).toMatchObject({ contributionCount: 3, lastPromptedAt: 30 });
      expect(
        projectSqliteSessionParticipants(f.database.db, f.target.sessionKey, next.entry!),
      ).toMatchObject({
        participantCount: 2,
        participants: [{ identity: { id: "second" } }, { identity: { id: "first" } }],
      });
      expect(reads.counts).toEqual({ participant: 0, hydration: 0 });
    } finally {
      reads.restore();
    }
  });
});

it("discards rolled-back participant facts and retains the next committed contribution", async () => {
  await withActor((f) => {
    const before = f.read();
    const record = () =>
      recordSessionParticipantFromWorker(f.database, f.scope, {
        identity: { type: "agent", id: "peer" },
        promptedAt: 10,
      });
    expect(() =>
      runSqliteImmediateTransactionSync(f.database.db, () => {
        record();
        expect(
          participantRecordsBySessionKey(f.database.db, [f.target.sessionKey]).get(
            f.target.sessionKey,
          ),
        ).toMatchObject([{ identity: { id: "peer" }, contributionCount: 1 }]);
        throw new Error("rollback participant");
      }),
    ).toThrow("rollback participant");
    const rolledBack = f.read();
    expect(rolledBack.participants).toEqual(before.participants);
    expect(rolledBack.entry).toEqual(before.entry);
    runSqliteImmediateTransactionSync(f.database.db, record);
    expect(f.read().participants).toMatchObject([
      { identity: { id: "peer" }, contributionCount: 1 },
    ]);
    f.restartActor();
    expect(f.read().participants).toMatchObject([
      { identity: { id: "peer" }, contributionCount: 1 },
    ]);
  });
});

it("retains resident session facts across usage cache writes and reloads actual session changes", async () => {
  await withActor(async (f) => {
    const initial = f.read();
    const usage = prepareSessionCostUsageRefreshLock(f.database.agentId, f.database.path);
    const reads = trackSqliteStatementExecutions(f.database.db, ["hydration"], (sql) =>
      sql.includes('as "actor_participants"') ? "hydration" : null,
    );
    const unchanged = () => {
      expect(f.read()).toEqual(initial);
      expect(reads.counts.hydration).toBe(0);
    };
    try {
      expect(await usage.acquire()).toBe(true);
      unchanged();
      expect(
        await usage.writeRollup({
          rollupId: "synthetic-rollup",
          valueJson: new TextEncoder().encode("{}"),
          blob: null,
          updatedAt: 2,
        }),
      ).toBe(true);
      unchanged();
      await usage.pruneRows([{ key: "synthetic-rollup", valueJson: "{}", updatedAt: 2 }]);
      unchanged();
      await usage.release();
      unchanged();

      runSqliteImmediateTransactionSync(f.database.db, () =>
        writeSessionEntry(f.database, f.target.sessionKey, {
          ...initial.entry!,
          label: "changed by the session owner",
        }),
      );
      expect(f.read().entry?.label).toBe("changed by the session owner");
      expect(reads.counts.hydration).toBe(1);
    } finally {
      reads.restore();
      await usage.release();
    }
  });
});

it("keeps transcript residency across entry patches without losing either owner's writes", async () => {
  await withActor(async (f) => {
    f.database.db
      .prepare(
        "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'main', 'Synthetic board', 0, 'user', 0)",
      )
      .run(f.target.sessionKey);
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "session",
          id: f.scope.sessionId,
          version: 3,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/synthetic",
        },
        {
          type: "message",
          id: "before-patch",
          parentId: null,
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "user", content: "retain this input" },
        },
      ]),
    );
    const before = f.read();
    const predicate: SessionEntryPatchGuard["shouldCommitIf"] = {
      kind: "transcript",
      sessionId: f.scope.sessionId,
      generation: before.transcript.watermark.generation,
      leafEntryId: "before-patch",
    };
    const entryPatch = (
      fields: { label?: string; lifecycleRevision?: string; model?: string },
      shouldCommitIf = predicate,
    ) =>
      f.patchEntry({
        selection: { kind: "entry", sessionKey: f.target.sessionKey, exact: true },
        sessionKey: f.target.sessionKey,
        operation: { kind: "fields", patch: fields },
        operationLabel: "session-entry.patch",
        validateCanonicalKeys: false,
        preserveActivity: true,
        shouldCommitIf,
      });
    const reads = trackSqliteStatementExecutions(f.database.db, ["select", "watermark"], (sql) =>
      sql.startsWith("select coalesce(") &&
      sql.includes('as "max_seq"') &&
      sql.includes('"session_transcript_cold_archives"')
        ? "watermark"
        : /^select\b/iu.test(sql)
          ? "select"
          : null,
    );
    try {
      entryPatch({ label: "entry owner committed", model: "updated-model" });
      expect(reads.counts.watermark).toBe(0);
      runSqliteImmediateTransactionSync(f.database.db, () =>
        recordSessionParticipantFromWorker(f.database, f.scope, {
          identity: { type: "agent", id: "peer" },
          promptedAt: 10,
        }),
      );
      reads.counts.select = 0;
      const after = f.read();
      expect(after.entry?.label).toBe("entry owner committed");
      expect(after.entry?.model).toBe("updated-model");
      expect(after.hasBoard).toBe(true);
      expect(after.participants).toMatchObject([
        { identity: { id: "peer" }, contributionCount: 1 },
      ]);
      expect(after.transcript).toEqual(before.transcript);
      expect(after.version).toEqual({ ...before.version, sequence: before.version.sequence + 2 });
      const accounting: Mutation = {
        type: "session.actor.patch",
        input: {
          target: after.target,
          expected: after.version,
          commandId: "activity-20",
          phaseId: "terminal-accounting",
          reducers: [{ kind: "activity", updatedAt: 20 }],
        },
      };
      await f.prepare(accounting);
      expect(f.mutate(accounting)).toMatchObject({
        kind: "committed",
        receipt: { postimage: { entry: { updatedAt: 20, label: "entry owner committed" } } },
      });
      const append: Mutation = {
        type: "session.actor.appendTranscriptEvent",
        input: {
          target: f.target,
          expected: f.read().version,
          commandId: "append-after-entry-patch",
          phaseId: "model",
          sessionId: f.scope.sessionId,
          lifecycleRevision: after.entry!.lifecycleRevision ?? null,
          eventJson: JSON.stringify({
            type: "model_change",
            id: "after-patch",
            parentId: "before-patch",
            timestamp: "2026-01-01T00:00:02Z",
            provider: "synthetic",
            modelId: "test-model",
          }),
        },
      };
      await f.prepare(append);
      expect(f.mutate(append).kind).toBe("committed");
      expect(reads.counts.select).toBe(0);
      entryPatch({ label: "wrong generation" }, { ...predicate, generation: "superseded" });
      entryPatch({ label: "wrong branch" }, { ...predicate, leafEntryId: "off-path" });
      expect(f.read().entry?.label).toBe("entry owner committed");
      entryPatch({ label: "entry owner committed" }, { ...predicate, leafEntryId: "after-patch" });
      expect(reads.counts.watermark).toBe(0);
    } finally {
      reads.restore();
    }
    expect(f.nativeEntry()).toMatchObject({ updatedAt: 20, label: "entry owner committed" });
    expect(
      readTranscriptEventRows(f.database, f.scope.sessionId).map(
        (row) => JSON.parse(row.eventJson).id,
      ),
    ).toEqual([f.scope.sessionId, "before-patch", "after-patch"]);

    const retained = f.read();
    f.hooks.admit = (stage) => {
      if (stage === "commit") {
        throw new Error("entry patch refused");
      }
    };
    expect(() => entryPatch({ label: "must roll back" })).toThrow("entry patch refused");
    delete f.hooks.admit;
    const rolledBack = f.read();
    expect(rolledBack.entry).toEqual(retained.entry);
    expect(rolledBack.transcript).toEqual(retained.transcript);
    expect(rolledBack.pendingInputs).toEqual(retained.pendingInputs);
    entryPatch({ lifecycleRevision: "new-lifecycle" });
    const replaced = f.read();
    expect(replaced.version.epoch).not.toBe(rolledBack.version.epoch);
    expect(replaced.entry?.lifecycleRevision).toBe("new-lifecycle");
    expect(replaced.entry?.model).toBe("updated-model");
    expect(replaced.hasBoard).toBe(true);
  });
});
