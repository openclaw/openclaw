import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("keeps transcript residency across entry patches without losing either owner's writes", async () => {
  await withActor(async (f) => {
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
    const entryPatch = (fields: { label?: string; lifecycleRevision?: string }) =>
      f.patchEntry({
        selection: { kind: "entry", sessionKey: f.target.sessionKey, exact: true },
        sessionKey: f.target.sessionKey,
        operation: { kind: "fields", patch: fields },
        operationLabel: "session-entry.patch",
        validateCanonicalKeys: false,
        preserveActivity: true,
      });
    entryPatch({ label: "entry owner committed" });
    const reads = trackSqliteStatementExecutions(f.database.db, ["select"], (sql) =>
      /^select\b/iu.test(sql) ? "select" : null,
    );
    try {
      const after = f.read();
      expect(after.entry?.label).toBe("entry owner committed");
      expect(after.transcript).toEqual(before.transcript);
      expect(after.version).toEqual({ ...before.version, sequence: before.version.sequence + 1 });
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
  });
});
