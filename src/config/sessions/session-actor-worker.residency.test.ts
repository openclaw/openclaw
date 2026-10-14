import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";

// mock-isolation: The actor fixture owns database lifetime without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("retains an oversized sole actor across commits and accounts its bytes when another actor arrives", async () => {
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
    const rehydrated = f.read();
    expect(rehydrated.version.epoch).not.toBe(current.version.epoch);
    expect(rehydrated.entry?.updatedAt).toBe(2);
    expect(rehydrated.entry?.label === largeLabel).toBe(true);
    const displaced = f.read(other);
    expect(displaced.version.epoch).not.toBe(competing.version.epoch);
    expect(displaced.entry).toMatchObject({ sessionId: "byte-budget-other", updatedAt: 1 });
  });
});
