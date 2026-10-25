import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { probeSqlite } from "../../node-sqlite-capabilities.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

type ProbeValue = string | Uint8Array;

const temporary = useAutoCleanupTempDirTracker(afterEach);

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
          import { DatabaseSync } from "node:sqlite";
          import { Worker } from "node:worker_threads";
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
            samePending, sameResult, capabilities,
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
      closed: 1,
      ...(permission
        ? {
            failure: sqlFailure
              ? expect.stringContaining("node:sqlite NUL round-trip capability check failed")
              : null,
            workerDenied: { code: "ERR_ACCESS_DENIED", permission: "WorkerThreads" },
            permissions: { worker: false, write: false, child: false },
          }
        : {}),
    });
  },
);

it.each([false, true])("loads a self-contained SQLite probe (bundled=%s)", (bundled) => {
  const root = temporary.make("sqlite-capability-bootstrap-");
  const files = ["node-sqlite.mjs", "node-version.mjs", "node-sqlite-capabilities.mjs"];
  for (const name of files) {
    copyFileSync(new URL("../../" + name, import.meta.url), path.join(root, name));
  }
  let entry = pathToFileURL(path.join(root, "node-sqlite.mjs"));
  if (bundled) {
    const outfile = path.join(root, "arbitrary execution directory", "bootstrap.mjs");
    buildSync({
      entryPoints: [path.join(root, "node-sqlite.mjs")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
    });
    entry = pathToFileURL(outfile);
    for (const name of files) {
      rmSync(path.join(root, name));
    }
  }
  const output = runProbe(`
    Function.prototype.toString = () => { throw new Error("function source unavailable"); };
    const { detectCurrentSqliteCapabilities } = await import(${JSON.stringify(entry.href)});
    const pending = detectCurrentSqliteCapabilities();
    const capabilities = await pending;
    process.stdout.write(JSON.stringify({
      capabilities, samePending: pending === detectCurrentSqliteCapabilities(),
    }));
  `);
  expect(output).toMatchObject({
    capabilities: { available: true, text: true, blob: true, json: true },
    samePending: true,
  });
});
