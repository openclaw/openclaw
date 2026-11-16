import path from "node:path";
import { expect, it } from "vitest";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";
import * as native from "../infra/sqlite-transaction.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "../state/openclaw-agent-standing-intents-schema.js";
import * as worker from "./sqlite-worker-runtime.js";

const transactionNames = [
  "runSqliteDeferredTransactionSync",
  "runSqliteImmediateTransactionSync",
  "runSqliteReadSnapshotSync",
] as const;

it("rejects inferred thenables at the private worker boundary and preserves released callers", () => {
  const cwd = path.resolve(import.meta.dirname, "../..");
  const sourceFileName = path.join(cwd, "src/plugin-sdk/sqlite-worker-runtime.consumer.ts");
  const configFileName = "tsconfig.sqlite-worker-runtime-types.json";
  const owners = [
    "src/plugin-sdk/sqlite-worker-runtime.ts",
    "extensions/knowledge/src/store-registry.ts",
    "extensions/logbook/src/store.worker.ts",
    "extensions/team-reports/src/store.worker.ts",
    "extensions/workboard/src/sqlite-store-kernel.ts",
    "extensions/workboard/src/sqlite-store.worker.ts",
    "extensions/memory-core/src/memory-entry-origins.worker.ts",
    "extensions/memory-core/src/standing-intents.worker.ts",
    "extensions/memory-core/src/memory/manager-publication.worker.ts",
    "src/infra/sqlite-transaction.ts",
    "src/infra/sqlite-transaction-types.ts",
    "src/infra/sqlite-source-fence.ts",
    "src/infra/sqlite-store.worker.ts",
    "src/agents/auth-profiles/inline-usage.worker.ts",
    "src/agents/harness/context-engine-turn-outbox.worker.ts",
    "src/agents/plugin-model-catalog.worker.ts",
    "src/boards/sqlite-board-store.worker.ts",
    "src/config/sessions/session-sharing-store.worker.ts",
    "src/config/sessions/session-transcript-projection-publication.worker.ts",
    "src/session-cards/progress-card-store.worker.ts",
  ];
  const transactions = [
    ...transactionNames.map((name) => ({ name, call: `worker.${name}(database` })),
    { name: "reserved", call: "native.runSqliteReservedTransactionSync(database" },
    { name: "coreWorker", call: "native.runSqliteWorkerTransactionSync(context" },
  ];
  const bodies = [
    ...transactions,
    { name: "singleStatement", call: "worker.runSqliteSingleStatementSync(database" },
  ].map(({ name, call }) => {
    const options = name === "reserved" ? ", {}" : "";
    return `
const ${name}Result: number = ${call}, () => 7${options});
${call}, () => {}${options});
${call}, () => { throw new Error("stopped"); }${options});
// @ts-expect-error an async callback escapes the synchronous transaction
${call}, async () => 7${options});
// @ts-expect-error non-async Promise returns also escape the transaction
${call}, () => Promise.resolve(7)${options});
// @ts-expect-error a union must not discard its asynchronous branch
${call}, mixed${options});
// @ts-expect-error inline union inference must retain its asynchronous branch
${call}, () => Math.random() ? 7 : Promise.resolve(7)${options});
// @ts-expect-error PromiseLike has the same transaction lifetime violation
${call}, thenable${options});
// @ts-expect-error contextual unknown must not widen an inferred Promise result
const ${name}Unknown: unknown = ${call}, async () => 7${options});
// @ts-expect-error contextual void must not erase an inferred Promise result
const ${name}Void: void = ${call}, async () => {}${options});
// @ts-expect-error synchronous result types must stay correlated with the callback
const ${name}Wrong: string = ${call}, () => 7${options});
`;
  });
  const commits = transactions.map(
    ({ call }) => `
${call}, () => 7, { withCommit(commit) { commit(); } });
${call}, () => 7, { withCommit(commit) { commit(); return 1; } });
// @ts-expect-error asynchronous commit guards must not outlive the transaction
${call}, () => 7, { withCommit: async (commit) => commit() });
// @ts-expect-error mixed commit results also contain an asynchronous branch
${call}, () => 7, { withCommit: mixedCommit });
// @ts-expect-error inline mixed commit inference must retain its asynchronous branch
${call}, () => 7, { withCommit: (commit) => Math.random() ? commit() : Promise.resolve() });
// @ts-expect-error PromiseLike commit results must remain synchronous
${call}, () => 7, { withCommit: thenableCommit });
`,
  );
  const session = createNativeTypeScriptProject({
    cwd,
    configFileName,
    files: {
      [configFileName]: JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { strict: true },
        files: [sourceFileName, ...owners],
        include: [],
      }),
      [sourceFileName]: `
import type { DatabaseSync } from "node:sqlite";
import * as native from "../infra/sqlite-transaction.js";
import { runSqliteSourceFence } from "../infra/sqlite-source-fence.js";
import * as worker from "./sqlite-worker-runtime.js";
import * as legacy from "./sqlite-runtime.js";
declare const database: DatabaseSync;
declare const context: Parameters<typeof native.runSqliteWorkerTransactionSync>[0];
declare const fence: Parameters<typeof runSqliteSourceFence>[0];
declare const mixed: () => number | Promise<number>;
declare const thenable: () => PromiseLike<number>;
declare const mixedCommit: (commit: () => void) => void | Promise<void>;
declare const thenableCommit: (commit: () => void) => PromiseLike<void>;
${bodies.join("\n")}
${commits.join("\n")}
function forward<Result>(operation: worker.SynchronousSqliteCallback<Result>): Result {
  return worker.runSqliteImmediateTransactionSync(database, operation);
}
function wrap<Result>(operation: worker.SynchronousSqliteCallback<Result>): Result {
  return worker.runSqliteImmediateTransactionSync(database, () => { return operation(); });
}
const forwarded: number = forward(() => 7);
const wrapped: number = wrap(() => 7);
function coreForward<Result>(operation: worker.SynchronousSqliteCallback<Result>): Result {
  return native.runSqliteWorkerTransactionSync(context, operation);
}
function reservedWrap<Result>(operation: worker.SynchronousSqliteCallback<Result>): Result {
  return native.runSqliteReservedTransactionSync(database, () => operation(), {});
}
const coreForwarded: number = coreForward(() => 7);
const reservedWrapped: number = reservedWrap(() => 7);
const inOperation = <Result>(operation: () => Result): Result => operation();
function fenceForward<Result>(operation: worker.SynchronousSqliteCallback<Result>): Promise<Result> {
  return runSqliteSourceFence(fence, inOperation, operation);
}
const fenced: Promise<number> = fenceForward(() => 7);
// @ts-expect-error the reserved execution producer must finish before settlement
runSqliteSourceFence(fence, inOperation, async () => 7);
// @ts-expect-error a reserved producer must retain its asynchronous union branch
runSqliteSourceFence(fence, inOperation, mixed);
worker.ensureOpenClawAgentStandingIntentsSchema(database, forward);
// @ts-expect-error schema transaction runners must also finish synchronously
worker.ensureOpenClawAgentStandingIntentsSchema(database, async (install) => install());
// @ts-expect-error mixed schema runner results retain their asynchronous branch
worker.ensureOpenClawAgentStandingIntentsSchema(database, (install) => Math.random() ? install() : Promise.resolve());
// @ts-expect-error declared mixed schema runners must remain synchronous
worker.ensureOpenClawAgentStandingIntentsSchema(database, mixedCommit);
// @ts-expect-error PromiseLike schema runners must remain synchronous
worker.ensureOpenClawAgentStandingIntentsSchema(database, thenableCommit);
// @ts-expect-error a guarded transaction cannot serve arbitrary unconstrained callbacks
const unguarded: <Result>(operation: () => Result) => Result = forward;
const object: { id: string } = worker.runSqliteReadSnapshotSync(database, () => ({ id: "fixture" }));
// Already-erased callbacks still depend on the unchanged runtime guard.
declare const erased: () => void;
worker.runSqliteImmediateTransactionSync(database, erased);
function legacyForward<Result>(operation: () => Result): Result {
  return legacy.runSqliteImmediateTransactionSync(database, operation);
}
legacyForward(async () => 7);
legacy.runSqliteImmediateTransactionSync(database, () => 7, {
  withCommit: async (commit) => commit(),
});
legacy.runSqliteImmediateTransaction(database, async () => () => 7, undefined, async (write) => write());
`,
    },
  });
  try {
    for (const fileName of [sourceFileName, ...owners.map((owner) => path.join(cwd, owner))]) {
      expect(
        session.project.program.getSemanticDiagnostics(fileName),
        path.relative(cwd, fileName),
      ).toEqual([]);
    }
  } finally {
    session.close();
  }
});

it("retains the native function identities and their runtime transaction guards", () => {
  for (const name of [...transactionNames, "runSqliteSingleStatementSync"] as const) {
    expect(worker[name]).toBe(native[name]);
  }
  expect(worker.ensureOpenClawAgentStandingIntentsSchema).toBe(
    ensureOpenClawAgentStandingIntentsSchema,
  );
});
