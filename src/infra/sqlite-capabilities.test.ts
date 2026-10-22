import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

type ProbeValue = string | Uint8Array;

function probeSqlite(Database: unknown): unknown {
  const context = { Buffer, Error, Uint8Array, require: () => ({ DatabaseSync: Database }) };
  return runInNewContext(SQLITE_CAPABILITY_PROBE, context);
}

function runProbe(script: string, env?: NodeJS.ProcessEnv): unknown {
  return JSON.parse(
    execFileSync(
      env ? resolveTestNodeExecPath() : process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10_000, ...(env ? { env } : {}) },
    ),
  );
}

it.each(["none", "text", "trailing", "blob", "json", "throw"] as const)(
  "detects %s corruption and closes the in-memory database",
  (corruption) => {
    const close = vi.fn();
    class FakeDatabase {
      row: Record<string, unknown> = {};
      exec() {}
      prepare(sql: string) {
        return {
          run: (text: ProbeValue, blob: ProbeValue, json: ProbeValue) => {
            this.row = { text_value: text, blob_value: blob, json_value: json };
          },
          get: () => {
            if (sql.includes("sqlite_version()")) {
              return { version: "3.51.3" };
            }
            if (corruption === "throw") {
              throw new Error("read failed");
            }
            const overrides: Partial<Record<typeof corruption, Record<string, unknown>>> = {
              text: { text_value: "a" },
              trailing: { text_value: "a\0b" },
              blob: { blob_value: new Uint8Array([97]) },
              json: { json_value: '{"value":"a"}' },
            };
            return { ...this.row, ...overrides[corruption] };
          },
        };
      }
      close = close;
    }
    expect(probeSqlite(FakeDatabase)).toEqual({
      available: true,
      version: "3.51.3",
      text: !["text", "trailing", "throw"].includes(corruption),
      blob: !["blob", "throw"].includes(corruption),
      json: !["json", "throw"].includes(corruption),
      ...(corruption === "throw" ? { error: "read failed" } : {}),
    });
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each([
  { permission: false, sqlFailure: false },
  { permission: true, sqlFailure: false },
  { permission: true, sqlFailure: true },
])(
  "caches real SQLite capabilities (permission=$permission, SQL failure=$sqlFailure)",
  ({ permission, sqlFailure }) => {
    const output = runProbe(
      `
          import { DatabaseSync, StatementSync } from "node:sqlite";
          import { Worker } from "node:worker_threads";
          const counts = {};
          for (const [prototype, names] of [
            [DatabaseSync.prototype, ["prepare", "exec"]],
            [StatementSync.prototype, ["get", "all", "run", "iterate"]],
          ]) {
            for (const name of names) {
              counts[name] = 0;
              const original = prototype[name];
              prototype[name] = function (...args) {
                counts[name]++;
                return Reflect.apply(original, this, args);
              };
            }
          }
            let closed = 0;
            const close = DatabaseSync.prototype.close;
            DatabaseSync.prototype.close = function (...args) {
              closed++;
              return Reflect.apply(close, this, args);
            };
            if (${sqlFailure}) {
              DatabaseSync.prototype.exec = function () {
                throw new Error("injected SQL failure");
              };
            }
          let workersStarted = 0;
          let workersExited = 0;
          process.on("worker", (worker) => {
            workersStarted++;
            worker.once("exit", () => workersExited++);
          });
          const { detectCurrentSqliteCapabilities, nodeRuntimeFailure } = await import(${JSON.stringify(new URL("../../node-sqlite.mjs", import.meta.url).href)});
          const pending = detectCurrentSqliteCapabilities();
          const samePending = pending === detectCurrentSqliteCapabilities();
          const capabilities = await pending;
          const sameResult = capabilities === await detectCurrentSqliteCapabilities();
            let workerDenied;
            if (${permission}) {
              try {
                new Worker("", { eval: true });
              } catch (error) {
                workerDenied = { code: error.code, permission: error.permission };
              }
            }
          process.stdout.write(JSON.stringify({
            asynchronous: pending instanceof Promise,
            samePending, sameResult, capabilities, workersStarted, workersExited, counts,
            closed, workerDenied,
            ...(${permission} ? {
              failure: nodeRuntimeFailure(process.versions.node, capabilities),
              permissions: {
                worker: process.permission.has("worker"),
                write: process.permission.has("fs.write"),
                child: process.permission.has("child"),
              },
            } : {}),
          }));
        `,
      permission ? { ...process.env, NODE_OPTIONS: "--permission --allow-fs-read=*" } : undefined,
    );
    expect(output).toMatchObject({
      asynchronous: true,
      samePending: true,
      sameResult: true,
      capabilities: {
        available: true,
        text: !sqlFailure,
        blob: !sqlFailure,
        json: !sqlFailure,
        ...(permission ? { version: expect.any(String) } : {}),
        ...(sqlFailure ? { error: "injected SQL failure" } : {}),
      },
      workersStarted: permission ? 0 : 1,
      ...(permission
        ? {
            failure: sqlFailure
              ? expect.stringContaining("node:sqlite NUL round-trip capability check failed")
              : null,
            closed: 1,
            workerDenied: { code: "ERR_ACCESS_DENIED", permission: "WorkerThreads" },
            permissions: { worker: false, write: false, child: false },
          }
        : {
            workersExited: 1,
            counts: { prepare: 0, exec: 0, get: 0, all: 0, run: 0, iterate: 0 },
          }),
    });
  },
);
