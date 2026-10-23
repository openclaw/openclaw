import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import nativeFs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { classifySqliteMutation } from "../../infra/sqlite-schema-mutation.js";
import { workspaceQuiescenceArgv } from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nonce = "a".repeat(32);
const require = createRequire(import.meta.url);

function runScript(
  command: string[],
  context: { process: object; require: (name: string) => unknown; [key: string]: unknown },
) {
  return runInNewContext(command[2]!, {
    performance: { now: () => 0 },
    ...context,
    process: Object.assign(context.process, { argv: [process.execPath, ...command.slice(3)] }),
  });
}

function acquisition(root = "/workspace") {
  return workspaceQuiescenceArgv(
    root,
    { action: "acquire", nonce, timeoutMs: 10_000 },
    "shared-host",
    "owned",
  );
}

function dependencies(overrides: Record<string, unknown>) {
  const modules: Record<string, unknown> = {
    "node:crypto": crypto,
    "node:path": path,
    "node:os": { homedir: () => "/home/worker" },
    ...overrides,
  };
  return (name: string) => {
    if (!(name in modules)) {
      throw new Error("unexpected dependency: " + name);
    }
    return modules[name];
  };
}

it("renews and releases an initialized Windows lease without repeating DDL", () => {
  const root = nativeFs.realpathSync(tempDirs.make("workspace-quiescence-warm-schema-"));
  const directory = path.join(root, ".openclaw-worker", "quiescence");
  const databasePath = path.join(directory, "windows-shared-host.sqlite");
  const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
  const output: string[] = [];
  const run = (operation: Parameters<typeof workspaceQuiescenceArgv>[1]) =>
    runScript(workspaceQuiescenceArgv(root, operation, "shared-host"), {
      process: {
        platform: "win32",
        stdout: { write: (value: string) => output.push(value) },
        stderr: { write: (value: string) => output.push(value) },
      },
      require: (name: string) => (name === "node:os" ? { homedir: () => root } : require(name)),
    });
  run({ action: "acquire", nonce: "", timeoutMs: 60_000 });
  const leaseNonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(output.at(-1)!)?.[1];
  expect(leaseNonce).toBeDefined();
  output.length = 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const sql = observeHostDataSql();
  try {
    run({ action: "renew", nonce: leaseNonce!, timeoutMs: 60_000, validationMode: "heartbeat" });
    run({ action: "release", nonce: leaseNonce! });
    expect(output).toEqual([`renewed ${leaseNonce}\n`, ""]);
    expect(
      database
        .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
        .get(workspaceKey),
    ).toBeUndefined();
    expect(
      sql.queries.filter((query) => classifySqliteMutation(query, "batch").mainSchemaChange),
    ).toEqual([]);
  } finally {
    sql.restore();
    database.close();
  }
});

it("closes the generated Windows lease database when admission fails", () => {
  const close = vi.fn();
  expect(() =>
    runScript(acquisition(), {
      process: { platform: "win32" },
      require: dependencies({
        "node:fs": { realpathSync: (value: string) => value, mkdirSync() {} },
        "node:child_process": {},
        "node:sqlite": {
          DatabaseSync: class {
            close = close;
            isTransaction = false;
            exec() {
              throw new Error("lease admission failed");
            }
          },
        },
      }),
    }),
  ).toThrow("lease admission failed");
  expect(close).toHaveBeenCalledOnce();
});

it("retires the generated sidecar transport and rejects already-queued acquisition", () => {
  const root = nativeFs.realpathSync(tempDirs.make("workspace-quiescence-sidecar-"));
  const events = new EventEmitter();
  const files = () => nativeFs.readdirSync(path.join(root, ".openclaw-worker", "quiescence"));
  const timers = new Set<() => void>();
  const forcedExit = vi.fn(() => {
    throw new Error("unexpected forced exit");
  });
  const child = Object.assign(events, {
    pid: 1234,
    platform: "linux",
    getuid: () => 1000,
    connected: true,
    stderr: { write: vi.fn() },
    stdin: { destroy: vi.fn() },
    send: vi.fn(),
    exit: forcedExit,
    reallyExit: forcedExit,
    disconnect: vi.fn(() => {
      child.connected = false;
      events.emit("disconnect");
    }),
  });
  runScript(acquisition(root), {
    process: child,
    require: dependencies({
      "node:fs": nativeFs,
      "node:os": { homedir: () => root },
      "node:child_process": { execFileSync: () => "synthetic start" },
    }),
    setTimeout: (callback: () => void) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  });
  expect([files().length, timers.size]).toEqual([1, 1]);
  events.emit("message", {
    type: "workspace-quiescence-control",
    action: "release",
    nonce,
    id: "release",
  });
  expect(files()).toEqual([]);
  expect(child.send).toHaveBeenLastCalledWith({
    type: "workspace-quiescence-result",
    action: "release",
    nonce,
    id: "release",
  });
  const queuedMessage = events.listeners("message")[0]!;
  events.emit("message", { type: "workspace-quiescence-retire", nonce });
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(child.stdin.destroy).toHaveBeenCalledOnce();
  expect(timers.size).toBe(0);
  expect(events.eventNames()).toEqual([]);
  const replies = child.send.mock.calls.length;
  queuedMessage({
    type: "workspace-quiescence-control",
    action: "acquire",
    nonce: "b".repeat(32),
    timeoutMs: 10_000,
    id: "late",
  });
  expect(files()).toEqual([]);
  expect(child.send).toHaveBeenCalledTimes(replies);
  expect(forcedExit).not.toHaveBeenCalled();
});
