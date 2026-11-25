import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

it("checks imported transaction results and effective commit hooks through the CLI", async ({
  signal,
}) => {
  await fixtures.run(async () => {
    const root = fixtures.createTempDir("transaction-boundary-");
    for (const file of [
      "scripts/check-sqlite-transaction-boundary.mts",
      "scripts/lib/native-typescript.mts",
      "scripts/lib/repo-root.mjs",
      "scripts/lib/ts-guard-utils.mts",
      "src/infra/sql-connection.ts",
      "src/infra/postgres-sync/connection.ts",
    ]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve(file), target);
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module" }),
      "pnpm-workspace.yaml": "packages: []\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023",
          strict: true,
          types: [],
        },
      }),
      "src/producers.ts": `
        export async function importedAsync() { return 1; }
        export function importedPromise() { return Promise.resolve(1); }
        export function maybeAsync() { return Math.random() ? 1 : Promise.resolve(1); }
        export function commitLater(commit: () => void) { commit(); return Promise.resolve(); }
        export function commitNow(commit: () => void) { commit(); }
        export function synchronous() { return 1; }
      `,
      "src/callbacks.ts": 'export * from "./producers.js";',
      "src/caller.ts": [
        'import { importedAsync, importedPromise, maybeAsync, commitLater, commitNow } from "./callbacks.js";',
        'import type { PostgresSqlConnection } from "./infra/sql-connection.js";',
        'import type { PostgresSyncConnection } from "./infra/postgres-sync/connection.js";',
        "declare const db: PostgresSqlConnection;",
        "declare const physical: PostgresSyncConnection;",
        "declare function runSqliteImmediateTransactionSync<T>(db: unknown, run: () => T, options?: { withCommit?: (commit: () => void) => void }): T;",
        "runSqliteImmediateTransactionSync(db, importedAsync);",
        "runSqliteImmediateTransactionSync(db, () => importedPromise());",
        "const options = { withCommit: commitLater };",
        "runSqliteImmediateTransactionSync(db, () => 1, options);",
        "runSqliteImmediateTransactionSync(db, () => 1, { ...options });",
        "db.runTransaction(importedAsync);",
        'db["runTransaction"](() => importedPromise(), { ...options });',
        "runSqliteImmediateTransactionSync(db, () => 1, { withCommit: commitNow, ...options });",
        "physical.runTransaction(importedAsync);",
        "runSqliteImmediateTransactionSync(db, () => 1, { ...options, withCommit: commitNow });",
        "runSqliteImmediateTransactionSync(db, maybeAsync);",
      ].join("\n"),
    });
    const run = () =>
      runNodeScript(
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          path.join(root, "scripts/check-sqlite-transaction-boundary.mts"),
        ],
        process.env,
        undefined,
        { cwd: root, signal, requireProcessTreeExit: process.platform !== "win32" },
      );
    const rejected = await run();
    expect(rejected.error).toBeUndefined();
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stdout).not.toContain("SQLite transaction boundary guard passed.");
    const callback = (line: number, name = "runSqliteImmediateTransactionSync") =>
      `- ${path.join("src", "caller.ts")}:${line}: passes an async callback to synchronous SQLite transaction helper "${name}"`;
    const hook = (line: number) =>
      `- ${path.join("src", "caller.ts")}:${line}: passes an async commit hook to synchronous SQLite transaction helper`;
    expect(rejected.stderr.split(/\r?\n/).filter((line) => line.startsWith("- "))).toEqual([
      callback(7),
      callback(8),
      hook(10),
      hook(11),
      callback(12, "runTransaction"),
      callback(13, "runTransaction"),
      hook(13),
      hook(14),
      callback(15, "runTransaction"),
      callback(17),
    ]);
    expect(rejected.stderr).toContain("Complete asynchronous preparation before the transaction");

    writeFixtureFiles(root, {
      "src/caller.ts": `
        import { importedAsync, commitLater, commitNow, synchronous } from "./callbacks.js";
        import type { PostgresSqlConnection } from "./infra/sql-connection.js";
        declare const db: PostgresSqlConnection;
        declare function runSqliteImmediateTransactionSync<T>(db: unknown, run: () => T, options?: { withCommit?: (commit: () => void) => void }): T;
        declare function runSqliteImmediateTransaction<T>(db: unknown, prepare: () => Promise<() => T>): Promise<T>;
        const options = { withCommit: commitLater };
        runSqliteImmediateTransactionSync(db, synchronous, { ...options, withCommit: commitNow });
        runSqliteImmediateTransactionSync(db, synchronous, { ...options, ["withCommit"]: commitNow });
        db.runTransaction(synchronous, { withCommit: commitNow });
        await runSqliteImmediateTransaction(db, async () => synchronous);
        const config = { runTransaction: async (run: () => Promise<number>) => run() };
        await config.runTransaction(importedAsync);
        function shadowed() {
          const importedAsync = () => 1;
          runSqliteImmediateTransactionSync(db, importedAsync);
        }
        function overloaded(): number;
        function overloaded(value: string): Promise<string>;
        function overloaded(value?: string) { return value ? Promise.resolve(value) : 1; }
        runSqliteImmediateTransactionSync(db, overloaded);
        let replaced: () => void = async () => {};
        replaced = () => {};
        runSqliteImmediateTransactionSync(db, replaced);
        const mutable: { withCommit?: (commit: () => void) => void } = { withCommit: commitLater };
        mutable.withCommit = commitNow;
        runSqliteImmediateTransactionSync(db, synchronous, mutable);
        runSqliteImmediateTransactionSync(db, synchronous, { ...mutable });
      `,
    });
    expect(await run()).toMatchObject({
      error: undefined,
      status: 0,
      stdout: "SQLite transaction boundary guard passed.\n",
      stderr: "",
    });
  });
});
