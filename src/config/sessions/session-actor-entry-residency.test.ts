import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSessionCostUsageRefreshLock } from "../../infra/session-cost-usage-cache.sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { createSqliteWorkerTransferCollector } from "../../infra/sqlite-worker-transfer.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import * as participantCache from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  participantRecordsBySessionKey,
  projectSqliteSessionParticipants,
} from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipantFromWorker } from "./session-accessor.sqlite-participants.native.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorReplica,
  readSessionActorProjectionReceipt,
} from "./session-actor-replica.js";
import {
  participantRecord,
  withActor,
  type Fixture,
  type Mutation,
} from "./session-actor-worker.test-support.js";
import type {
  SessionEntryPatchCommitted,
  SessionEntryPatchGuard,
} from "./session-entry-patch.types.js";
import { readSessionEntryPatchSnapshot } from "./session-entry-patch.worker.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { withSessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts-scope.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { timedMessageEvent, messageEvent } from "./transcript-message.test-support.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("persists run adoption and its reducers once, then skips an unchanged hydrated row", async () => {
  await withActor(async (f) => {
    const initial = f.read();
    const command: Mutation = {
      type: "session.actor.adoptRun",
      input: {
        target: f.target,
        expected: initial.version,
        commandId: "adopt-with-activity",
        phaseId: "adoption",
        sessionId: f.scope.sessionId,
        expectedState: buildRestartRecoveryExpectedState(initial.entry!),
        runId: "current-run",
        lifecycle: { startedAt: 2 },
        reducers: [{ kind: "activity", updatedAt: 20 }],
      },
    };
    await f.prepare(command);
    const writes = trackSqliteStatementExecutions(f.database.db, ["nodes", "windows"], (sql) => {
      const table = /^(?:insert into|update|delete from) "([^"]+)"/iu.exec(sql)?.[1];
      return table === "session_nodes" ? "nodes" : table === "session_windows" ? "windows" : null;
    });
    try {
      expect(f.mutate(command)).toMatchObject({
        kind: "committed",
        receipt: {
          postimage: { entry: { activeWriterRunId: "current-run", startedAt: 2, updatedAt: 20 } },
        },
      });
      expect(writes.counts).toEqual({ nodes: 1, windows: 1 });
      writes.counts.nodes = 0;
      writes.counts.windows = 0;
      f.restartActor();
      const hydrated = f.read();
      expect(hydrated.entry).toMatchObject({
        activeWriterRunId: "current-run",
        startedAt: 2,
        updatedAt: 20,
      });
      expect(
        f.mutate({
          ...command,
          input: {
            ...command.input,
            expected: hydrated.version,
            commandId: "unchanged-after-hydration",
            expectedState: buildRestartRecoveryExpectedState(hydrated.entry!),
            // Clearing an absent optional field changes the in-memory shape, not the stored row.
            lifecycle: { endedAt: undefined },
            reducers: [],
          },
        }),
      ).toMatchObject({ kind: "committed" });
      expect(writes.counts).toEqual({ nodes: 0, windows: 0 });
      expect(f.nativeEntry()).toEqual(hydrated.entry);

      runSqliteImmediateTransactionSync(f.database.db, () =>
        f.database.db
          .prepare("UPDATE session_nodes SET label = ? WHERE session_key = ?")
          .run("stale-derived-label", f.target.sessionKey),
      );
      f.restartActor();
      const repair = f.read();
      expect(repair.entry?.label).toBe("initial");
      writes.counts.nodes = 0;
      writes.counts.windows = 0;
      expect(
        f.mutate({
          ...command,
          input: {
            ...command.input,
            expected: repair.version,
            commandId: "repair-hydrated-column",
            expectedState: buildRestartRecoveryExpectedState(repair.entry!),
            lifecycle: { endedAt: undefined },
            reducers: [],
          },
        }),
      ).toMatchObject({ kind: "committed" });
      expect(writes.counts).toEqual({ nodes: 1, windows: 0 });
      expect(
        f.database.db
          .prepare("SELECT label FROM session_nodes WHERE session_key = ?")
          .get(f.target.sessionKey),
      ).toMatchObject({ label: "initial" });
    } finally {
      writes.restore();
    }
  });
});

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
        expect(participants()).toMatchObject([participantRecord("second", 1, 20)]);
        expect(record("first", 10).value).toBe("inserted");
        expect(record("second", 5).value).toBe("updated");
        expect(participants()?.map((participant) => participant.identity.id)).toEqual([
          "second",
          "first",
        ]);
      });
      expect(f.read().participants).toEqual(participants());
      expect(participants()).toMatchObject([
        participantRecord("second", 2, 5, 20),
        participantRecord("first", 1, 10),
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

it("autocommits resident contributions and keeps consecutive actor counts current", async () => {
  await withActor((f) => {
    f.read();
    const input = { identity: { type: "agent" as const, id: "peer" }, promptedAt: 10 };
    f.participant(input);
    const sql = trackSqliteStatementExecutions(f.database.db, ["contribution", "read"], (text) =>
      /^insert into "session_participants"/iu.test(text)
        ? "contribution"
        : /^select\b/iu.test(text)
          ? "read"
          : null,
    );
    const exec = vi.spyOn(f.database.db, "exec");
    try {
      f.participant({ ...input, promptedAt: 20 });
      f.participant({ ...input, promptedAt: 30 });
      expect(f.read().participants).toMatchObject([participantRecord("peer", 3, 10, 30)]);
      expect(sql.counts).toEqual({ contribution: 2, read: 0 });
      expect(exec.mock.calls.some(([text]) => /BEGIN|COMMIT/iu.test(text))).toBe(false);
    } finally {
      exec.mockRestore();
      sql.restore();
    }
    f.restartActor();
    expect(f.read().participants).toMatchObject([{ contributionCount: 3, lastPromptedAt: 30 }]);
  });
});

it("refuses a prepared contribution before its statement and retains it after publication failure", async () => {
  await withActor((f) => {
    f.read();
    const input = { identity: { type: "agent" as const, id: "peer" }, promptedAt: 10 };
    f.participant(input);
    for (const refused of ["transaction", "commit"] as const) {
      f.hooks.admit = (stage) => {
        if (stage === refused) {
          throw new Error("participant admission refused");
        }
      };
      expect(() => f.participant(input)).toThrow("participant admission refused");
    }
    f.hooks.admit = undefined;
    expect(f.read().participants).toMatchObject([{ contributionCount: 1 }]);
    const publish = vi
      .spyOn(participantCache, "publishSessionEntryCacheParticipantUpdate")
      .mockImplementation(() => {
        throw new Error("participant publication failed");
      });
    try {
      expect(f.participant({ ...input, promptedAt: 20 })).toMatchObject({ value: "updated" });
      expect(f.read().participants).toMatchObject([{ contributionCount: 2, lastPromptedAt: 20 }]);
    } finally {
      publish.mockRestore();
    }
    f.restartActor();
    expect(f.read().participants).toMatchObject([{ contributionCount: 2, lastPromptedAt: 20 }]);
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
        await usage.writeRollup([
          {
            rollupId: "synthetic-rollup",
            valueJson: new TextEncoder().encode("{}"),
            blob: null,
            updatedAt: 2,
          },
        ]),
      ).toBe(true);
      unchanged();
      await usage.pruneRows([{ key: "synthetic-rollup", valueJson: "{}", updatedAt: 2 }]);
      unchanged();
      await usage.release();
      unchanged();

      f.writeEntry({ ...initial.entry!, label: "changed by the session owner" });
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
        timedMessageEvent("before-patch", null, "2026-01-01T00:00:01Z", {
          role: "user",
          content: "retain this input",
        }),
      ]),
    );
    f.writeEntry({
      ...f.nativeEntry()!,
      skillsSnapshot: {
        prompt: "synthetic snapshot",
        skills: Array.from({ length: 256 }, (_, index) => ({
          name: `fixture-${index}`,
          requiredEnv: [`SYNTHETIC_${index}`],
        })),
      },
      activitySummary: {
        version: 1,
        text: "Retained input",
        updatedAt: 10,
        sessionId: f.scope.sessionId,
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 1,
        totalMessages: 1,
        omittedContent: false,
      },
    });
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
      let candidate: SessionEntryPatchCommitted | undefined;
      const transfer = createSqliteWorkerTransferCollector("patch", (value) => {
        // The real patch kernel owns this candidate; the collector decodes its wire bytes.
        candidate = value as SessionEntryPatchCommitted;
      });
      f.hooks.admit = (_stage, facts) => {
        if (isRecord(facts) && facts.transfer) {
          transfer.accept(facts.transfer);
        }
      };
      entryPatch({ label: "entry owner committed", model: "updated-model" });
      delete f.hooks.admit;
      assert(transfer.completed && candidate?.entry?.skillsSnapshot);
      // The mutable caller result and retained publication each need one snapshot copy.
      expect(serialize(candidate).byteLength).toBeLessThan(
        serialize(candidate.entry).byteLength * 2.5,
      );
      candidate.entry.skillsSnapshot.prompt = "caller-owned edit";
      expect(
        candidate.publication?.fullEntries?.get(f.target.sessionKey)?.skillsSnapshot?.prompt,
      ).toBe("synthetic snapshot");
      expect(f.read().entry?.skillsSnapshot?.prompt).toBe("synthetic snapshot");
      expect(reads.counts.watermark).toBe(0);
      expect(reads.counts.select).toBe(0);
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
      expect(
        readSessionEntryPatchSnapshot(f.database, {
          kind: "entry",
          sessionKey: f.target.sessionKey,
          exact: true,
        })[0]?.row?.transcriptWatermark,
      ).toEqual({ sessionId: f.scope.sessionId, generation: expect.any(String), maxSeq: 2 });
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

it.each(["entry", "target"] as const)(
  "patches %s from current actor facts without losing intervening writes or publishing a rollback",
  async (kind) => {
    await withActor((f) => {
      f.read();
      const selection =
        kind === "entry"
          ? { kind, sessionKey: f.target.sessionKey, exact: false }
          : {
              kind,
              target: { canonicalKey: f.target.sessionKey, storeKeys: [f.target.sessionKey] },
            };
      if (kind === "entry") {
        expect(
          readSessionEntryPatchSnapshot(f.database, {
            kind,
            sessionKey: ` ${f.target.sessionKey} `,
            exact: true,
          }),
        ).toEqual([]);
        expect(
          readSessionEntryPatchSnapshot(f.database, {
            kind,
            sessionKey: ` ${f.target.sessionKey} `,
            exact: false,
          })[0]?.sessionKey,
        ).toBe(f.target.sessionKey);
      }
      const snapshot = () => readSessionEntryPatchSnapshot(f.database, selection);
      const prepare = (label: string) => {
        const prepared = snapshot();
        const writeBase = prepared[0]!.entry;
        return {
          selection,
          prepared,
          writeBase,
          next: { ...writeBase, label },
          sessionKey: f.target.sessionKey,
          operationLabel: "session-entry.patch" as const,
          validateCanonicalKeys: false,
        };
      };
      // Warm publication setup before measuring ordinary patches.
      f.patchEntry(prepare("warm publication"));
      const reads = trackSqliteStatementExecutions(f.database.db, ["select"], (sql) =>
        /^select\b/iu.test(sql) ? "select" : null,
      );
      try {
        const stale = prepare("stale replacement");
        f.patchEntry(prepare("first committed patch"));
        expect(snapshot()[0]?.entry.label).toBe("first committed patch");
        expect(() => f.patchEntry(stale)).toThrow(/changed|conflict/i);
        f.patchEntry(prepare("second committed patch"));
        expect(snapshot()[0]?.entry.label).toBe("second committed patch");
        expect(reads.counts.select).toBe(0);

        const refused = prepare("must roll back");
        f.hooks.admit = (stage) => {
          if (stage === "commit") {
            throw new Error("patch commit refused");
          }
        };
        expect(() => f.patchEntry(refused)).toThrow("patch commit refused");
        delete f.hooks.admit;
        expect(snapshot()[0]?.entry.label).toBe("second committed patch");
      } finally {
        reads.restore();
      }
      expect(f.nativeEntry()?.label).toBe("second committed patch");

      const beforeExternalWrite = prepare("stale after another owner writes");
      f.writeEntry({ ...f.nativeEntry()!, model: "other owner model" });
      expect(() => f.patchEntry(beforeExternalWrite)).toThrow(/changed|conflict/i);
      expect(snapshot()[0]?.entry.model).toBe("other owner model");
      f.restartActor();
      expect(snapshot()[0]?.entry).toMatchObject({
        label: "second committed patch",
        model: "other owner model",
      });
    });
  },
);

const question = messageEvent("question", null, { role: "user", content: "A question about 🦞" });
const answer = messageEvent("answer", "question", { role: "assistant", content: "An answer" });

const storedBytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;

function seed(f: Fixture, prettyQuestion = false) {
  const header = { type: "session", id: f.scope.sessionId, version: 3, cwd: "/synthetic" };
  const questionJson = JSON.stringify(question, null, prettyQuestion ? 2 : undefined);
  runSqliteImmediateTransactionSync(f.database.db, () => {
    appendTranscriptEventInTransaction(f.database, f.scope, header);
    appendTranscriptEventInTransaction(f.database, f.scope, question, { eventJson: questionJson });
    appendTranscriptEventInTransaction(f.database, f.scope, answer);
  });
  // Native hydration supplies navigation and bytes without retaining transcript payloads.
  f.restartActor();
  return { header, questionJson };
}

function reader(f: Fixture) {
  if (f.target.database.kind !== "file") {
    throw new Error("Context metadata proof requires a durable actor");
  }
  const replica = createSessionActorReplica({
    target: { ...f.target, database: f.target.database },
    lifetime: { assertCurrent() {}, assertReadable() {} },
    currentGeneration: () => "context-metadata-proof",
  });
  const receipt = () => {
    const retained = readSessionActorProjectionReceipt({
      path: f.database.path,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
    });
    if (!retained) {
      throw new Error("Actor did not publish its projection receipt");
    }
    return retained;
  };
  const accounting = () =>
    withSessionTranscriptProjectionReceipt({ ...receipt(), contextOnly: true }, () =>
      readCurrentProjectionSnapshot(f.database, f.scope, (projection) =>
        readSessionTranscriptAccountingFromProjection(projection, {
          includeByteSize: true,
          includeUsage: false,
        }),
      ),
    );
  return {
    replica,
    receipt,
    install() {
      expect(replica.beginRead()(f.read())).toBe(true);
    },
    expectAccounting(eventCount: number, byteSize: number) {
      expect(accounting()).toMatchObject({ kind: "value", value: { eventCount, byteSize } });
    },
    bounded: () =>
      withSessionTranscriptProjectionReceipt(receipt(), () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        }),
      ),
  };
}

it("reads rewritten stored bytes from compact receipts and preserves committed totals on rollback", async () => {
  await withActor((f) => {
    const { header, questionJson } = seed(f, true);
    const context = reader(f);
    try {
      context.install();
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      context.expectAccounting(2, Buffer.byteLength(questionJson) + 1 + storedBytes(answer));

      const rewritten = {
        ...question,
        message: { ...question.message, __openclaw: { steerTargetRunId: "committed-next-run" } },
      };
      runSqliteImmediateTransactionSync(f.database.db, () => {
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: 1, expectedEventJson: questionJson, event: rewritten },
        ]);
      });
      // The compact publication updates exact totals without copying row metadata.
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      const expected = { eventCount: 2, byteSize: storedBytes(rewritten) + storedBytes(answer) };
      context.expectAccounting(expected.eventCount, expected.byteSize);
      expect(context.bounded()).toMatchObject({
        events: [header, rewritten, answer],
        serializedBytes: storedBytes(header) + expected.byteSize,
      });

      const rolledBack = {
        ...rewritten,
        message: {
          ...rewritten.message,
          __openclaw: { steerTargetRunId: "uncommitted-run-with-a-different-size" },
        },
      };
      expect(() =>
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
            { seq: 1, expectedEventJson: JSON.stringify(rewritten), event: rolledBack },
          ]);
          throw new Error("Synthetic context rewrite rollback");
        }),
      ).toThrow("Synthetic context rewrite rollback");
      context.install();
      context.expectAccounting(expected.eventCount, expected.byteSize);
      expect(context.bounded().events).toEqual([header, rewritten, answer]);
    } finally {
      context.replica.close();
    }
  });
});

it.each(["reset", "compaction", "leaf"] as const)(
  "reads the durable context after %s changes the active window",
  async (kind) => {
    await withActor((f) => {
      const { header } = seed(f);
      const context = reader(f);
      try {
        context.install();
        expect(context.receipt().facts?.contextMetadata).toBeUndefined();
        const control =
          kind === "leaf"
            ? { type: kind, id: "control", parentId: "answer", targetId: "question" }
            : kind === "compaction"
              ? {
                  type: kind,
                  id: "control",
                  parentId: "answer",
                  summary: "The earlier conversation",
                  tokensBefore: 20,
                }
              : { type: kind, id: "control", parentId: "answer", reason: "new" };
        const tail = {
          ...question,
          id: "tail",
          parentId: kind === "leaf" ? "question" : "control",
          message: { role: "user", content: "Continue in the selected window" },
        };
        runSqliteImmediateTransactionSync(f.database.db, () => {
          appendTranscriptEventsInTransaction(f.database, f.scope, [control, tail], {
            scheduleProjectionReconcile: false,
          });
          reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId);
        });
        context.install();
        expect(context.receipt().facts?.contextMetadata).toBeUndefined();
        const counted =
          kind === "reset" ? [tail] : kind === "compaction" ? [control, tail] : [question, tail];
        context.expectAccounting(
          counted.length,
          counted.reduce((total, event) => total + storedBytes(event), 0),
        );
        const bounded = context.bounded();
        expect(bounded.boundaryCount).toBe(kind === "leaf" ? 0 : 1);
        expect(bounded.events).toEqual(
          kind === "leaf" ? [header, question, tail] : [header, question, answer, control, tail],
        );
      } finally {
        context.replica.close();
      }
    });
  },
);

it("keeps exact accounting through appends and rewrites beyond the actor's resident window without rescanning", async () => {
  await withActor(async (f) => {
    const events = Array.from({ length: 600 }, (_, index) =>
      messageEvent(`message-${index}`, index === 0 ? null : `message-${index - 1}`, {
        role: "user",
        content: "x",
      }),
    );
    runSqliteImmediateTransactionSync(f.database.db, () => {
      appendTranscriptEventsInTransaction(f.database, f.scope, events, {
        scheduleProjectionReconcile: false,
      });
    });
    const context = reader(f);
    try {
      context.install();
      const stats = trackSqliteStatementExecutions(f.database.db, ["aggregate"], (sql) =>
        /\bsum\(/iu.test(sql) && sql.includes('"transcript_events"') ? "aggregate" : null,
      );
      const originalBytes = events.reduce((total, event) => total + storedBytes(event), 0);
      context.expectAccounting(events.length, originalBytes);
      const appended = {
        type: "message" as const,
        id: "after-window",
        parentId: events.at(-1)!.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: question.message,
      };
      const command: Mutation = {
        type: "session.actor.appendTranscriptEvent",
        input: {
          target: f.target,
          commandId: "append-after-window",
          phaseId: "append",
          append: {
            kind: "metadata",
            input: {
              scope: f.scope,
              event: appended,
              message: {
                messageJson: JSON.stringify(appended.message),
                cwd: "/synthetic",
                validateTurn: false,
              },
              options: {},
            },
          },
        },
      };
      const rewritten = {
        ...appended,
        message: { ...appended.message, __openclaw: { steerTargetRunId: "new-run" } },
      };
      try {
        await f.prepare(command);
        expect(f.mutate(command)).toMatchObject({ kind: "committed" });
        context.install();
        context.expectAccounting(events.length + 1, originalBytes + storedBytes(appended));
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
            { seq: events.length, expectedEventJson: JSON.stringify(appended), event: rewritten },
          ]);
        });
        context.expectAccounting(events.length + 1, originalBytes + storedBytes(rewritten));
        expect(stats.counts.aggregate).toBe(0);
      } finally {
        stats.restore();
      }
      expect(
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        }),
      ).toMatchObject({ events: [...events.slice(-99), rewritten], truncated: true });
    } finally {
      context.replica.close();
    }
  });
});

it("retains one oversized actor across competing small actors and replaces it with a second oversized actor", async () => {
  await withActor(async (f) => {
    const largeLabel = "x".repeat(9 * 1024 * 1024);
    const other = { ...f.target, sessionKey: "agent:main:byte-budget-other" };
    const companion = { ...f.target, sessionKey: "agent:main:byte-budget-companion" };
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, f.target.sessionKey, {
        sessionId: f.scope.sessionId,
        updatedAt: 1,
        label: largeLabel,
      });
      writeSessionEntry(f.database, other.sessionKey, {
        sessionId: "byte-budget-other",
        updatedAt: 1,
      });
      writeSessionEntry(f.database, companion.sessionKey, {
        sessionId: "byte-budget-companion",
        updatedAt: 1,
      });
    });

    const small = f.read(other);
    f.read(companion);
    expect(f.read(other).version).toEqual(small.version);

    const initial = f.read();
    const command: Mutation = {
      type: "session.actor.patch",
      input: {
        target: initial.target,
        expected: initial.version,
        commandId: "oversized-activity",
        phaseId: "terminal-accounting",
        reducers: [{ kind: "activity", updatedAt: 2 }],
      },
    };
    await f.prepare(command);
    const committed = f.mutate(command);
    if (committed.kind !== "committed") {
      throw new Error("Expected the oversized sole actor to commit without rehydration");
    }
    expect(committed.failure).toBeUndefined();
    expect(f.reply()).toEqual({ kind: "committed" });
    expect(committed.receipt.afterVersion).toEqual({
      epoch: initial.version.epoch,
      sequence: initial.version.sequence + 1,
    });
    const current = f.read();
    expect(current.version).toEqual(committed.receipt.afterVersion);
    expect(current.entry?.updatedAt).toBe(2);
    expect(current.entry?.label === largeLabel).toBe(true);

    const competing = f.read(other);
    expect(f.read().version).toEqual(current.version);
    expect(f.read(other).version).toEqual(competing.version);
    const neighboring = f.read(companion);
    expect(f.read(other).version).toEqual(competing.version);
    expect(f.read(companion).version).toEqual(neighboring.version);

    expect(
      f.mutate({
        ...command,
        input: { ...command.input, expected: current.version, commandId: "competing-activity" },
      }).kind,
    ).toBe("committed");

    f.writeEntry(
      { sessionId: "byte-budget-companion", updatedAt: 2, label: largeLabel },
      companion.sessionKey,
    );
    const secondOversized = f.read(companion);
    expect(secondOversized.version.epoch).not.toBe(neighboring.version.epoch);
    expect(f.read(other).version).toEqual(competing.version);
    const rehydrated = f.read();
    expect(rehydrated.version.epoch).not.toBe(current.version.epoch);
    expect(rehydrated.entry?.updatedAt).toBe(2);
    expect(rehydrated.entry?.label === largeLabel).toBe(true);
    expect(f.read(other).version).toEqual(competing.version);
    expect(f.read(companion).version.epoch).not.toBe(secondOversized.version.epoch);

    f.read();
    f.writeEntry({ sessionId: f.scope.sessionId, updatedAt: 3, label: "small replacement" });
    const smaller = f.read();
    f.read(other);
    f.read(companion);
    expect(f.read().version).toEqual(smaller.version);
    expect(f.read().entry?.label).toBe("small replacement");
  });
});

it("evicts ordinary actors under byte pressure while keeping the oversized working set", async () => {
  await withActor((f) => {
    const ordinary = { ...f.target, sessionKey: "agent:main:ordinary" };
    const newcomers = Array.from({ length: 3 }, (_, index) => ({
      ...f.target,
      sessionKey: `agent:main:newcomer-${index}`,
    }));
    runSqliteImmediateTransactionSync(f.database.db, () => {
      // Stored JSON, parsed rows, and hot entries together exceed the ordinary budget.
      for (const [target, mib] of [
        [f.target, 9],
        [ordinary, 1],
        ...newcomers.map((newcomer) => [newcomer, 1] as const),
      ] as const) {
        writeSessionEntry(f.database, target.sessionKey, {
          sessionId: target.sessionKey,
          updatedAt: 1,
          label: "x".repeat(mib * 1024 * 1024),
        });
      }
    });
    const oversizedVersion = f.read().version;
    const ordinaryVersion = f.read(ordinary).version;
    for (const newcomer of newcomers) {
      f.read(newcomer);
    }
    expect(f.read().version).toEqual(oversizedVersion);
    expect(f.read(ordinary).version.epoch).not.toBe(ordinaryVersion.epoch);
    expect(f.read().version).toEqual(oversizedVersion);
  });
});
