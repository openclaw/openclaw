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

it("tracks aliases of synchronous transaction imports", () => {
  check(`
        import { runSqliteImmediateTransactionSync as transact } from "./sqlite-transaction.js";
        transact(db, async () => undefined);
      `).toEqual([asyncCallback(3, "runSqliteImmediateTransactionSync")]);
});

it("allows asynchronous preparation followed by a synchronous commit callback", () => {
  check(`
        const prepared = await prepareMutation();
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
