import { afterAll, expect, it } from "vitest";
import { findSqliteTransactionBoundaryViolations } from "../../scripts/check-sqlite-transaction-boundary.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function check(content: string) {
  const source = parser.parseSourceFile("source.ts", content);
  return expect(findSqliteTransactionBoundaryViolations(content, "source.ts", source));
}

function asyncCallback(line: number, name: string) {
  return {
    line,
    reason: `passes an async callback to synchronous SQLite transaction helper "${name}"`,
  };
}

function removedPrimitive(line: number, action: string, name: string) {
  return { line, reason: `${action} removed async SQLite transaction primitive "${name}"` };
}

it("rejects removed async transaction primitives", () => {
  check(`
        import { runSqliteImmediateTransactionAsync } from "./sqlite-transaction.js";
        export async function runOpenClawAgentWriteTransactionAsync() {}
        await database.runSqliteImmediateTransactionAsync(async () => undefined);
      `).toEqual([
    removedPrimitive(2, "imports", "runSqliteImmediateTransactionAsync"),
    removedPrimitive(3, "declares", "runOpenClawAgentWriteTransactionAsync"),
    removedPrimitive(4, "calls", "runSqliteImmediateTransactionAsync"),
  ]);
});

it("rejects inline async callbacks passed to synchronous transaction helpers", () => {
  check(`
        runSqliteImmediateTransactionSync(db, async () => await prepare());
        runOpenClawAgentWriteTransaction(async (database) => await write(database), options);
        runOpenClawStateWriteTransaction(async (database) => await write(database));
        await runOpenClawAgentWriteWithYieldingAdmission(async (database) => await write(database), options);
      `).toEqual([
    asyncCallback(2, "runSqliteImmediateTransactionSync"),
    asyncCallback(3, "runOpenClawAgentWriteTransaction"),
    asyncCallback(4, "runOpenClawStateWriteTransaction"),
    asyncCallback(5, "runOpenClawAgentWriteWithYieldingAdmission"),
  ]);
});

it("rejects local async function references passed as callbacks", () => {
  check(`
        async function writeRows() {}
        const writeAgentRows = async () => undefined;
        runSqliteImmediateTransactionSync(db, writeRows);
        runOpenClawAgentWriteTransaction(writeAgentRows, options);
      `).toEqual([
    asyncCallback(4, "runSqliteImmediateTransactionSync"),
    asyncCallback(5, "runOpenClawAgentWriteTransaction"),
  ]);
});

it.each([
  "runPostgresTransactionSync",
  "runSqliteReservedTransactionSync",
  "runSqliteDeferredTransactionSync",
  "runSqliteReadSnapshotSync",
  "runSqliteSingleStatementSync",
  "runSqliteWorkerTransactionSync",
])("rejects async callbacks through %s, including aliases and references", (name) => {
  check(`
        import { ${name} as transact } from "./transaction.js";
        async function writeRows() {}
        ${name}(db, async () => undefined);
        transact(db, writeRows);
        ${name}(db, () => 42);
      `).toEqual([asyncCallback(4, name), asyncCallback(5, name)]);
});

it("tracks aliases of synchronous transaction imports", () => {
  check(`
        import { runSqliteImmediateTransactionSync as transact } from "./sqlite-transaction.js";
        transact(db, async () => undefined);
      `).toEqual([asyncCallback(3, "runSqliteImmediateTransactionSync")]);
});

it("rejects async actor callbacks through aliases and local references", () => {
  check(`
        import { withSessionActorTransactionState as inActor } from "./session-actor-transaction.js";
        async function mutate() {}
        inActor(database, state, mutate);
        withSessionActorTransactionState(database, state, async () => undefined);
        withSqliteDatabaseWriteScope(database, keys, mutate);
        inActor(database, state, () => 42);
      `).toEqual([
    asyncCallback(4, "withSessionActorTransactionState"),
    asyncCallback(5, "withSessionActorTransactionState"),
    asyncCallback(6, "withSqliteDatabaseWriteScope"),
  ]);
});

it("rejects async commit hooks without forbidding async preparation or unrelated hooks", () => {
  check(`
        import { runSqliteImmediateTransactionSync as transact } from "./sqlite-transaction.js";
        async function commitLater() {}
        transact(db, () => 42, { ...options, async withCommit(commit) { commit(); } });
        runPostgresTransactionSync(db, () => 42, { withCommit: commitLater });
        runSqliteImmediateTransaction(db, async () => () => 42, { withCommit: async (commit) => commit() });
        const withCommit = async () => undefined;
        transact(db, () => 42, { withCommit });
        transact(db, () => 42, { "withCommit": async function (commit) { commit(); } });
        transact(db, () => 42, { ...options, withCommit(commit) { commit(); } });
        createSession({ withCommit: async (commit) => await commit() });
      `).toEqual(
    [4, 5, 6, 8, 9].map((line) => ({
      line,
      reason: "passes an async commit hook to synchronous SQLite transaction helper",
    })),
  );
});

it("allows asynchronous preparation followed by a synchronous commit callback", () => {
  check(`
        const prepared = await prepareMutation();
        await runSqliteImmediateTransaction(db, async () => () => apply(prepared));
        runOpenClawAgentWriteTransaction((database) => {
          validate(database, prepared.expected);
          apply(database, prepared.patch);
        }, options);
        await runOpenClawAgentWriteWithYieldingAdmission((database) => {
          validate(database, prepared.expected);
          apply(database, prepared.patch);
        }, options);
      `).toEqual([]);
});
