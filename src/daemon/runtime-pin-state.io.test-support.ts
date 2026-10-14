// Runs in a fresh Linux process so Vitest workers cannot contaminate the I/O interval.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  assertDaemonRuntimePinCurrent,
  readDaemonRuntimePinForInstall,
} from "./runtime-pin-state.js";
import type { DaemonRuntimePinSnapshot } from "./runtime-pin-types.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const counters = [
  "rchar",
  "wchar",
  "syscr",
  "syscw",
  "read_bytes",
  "write_bytes",
  "cancelled_write_bytes",
] as const;
function readIo() {
  const fields = new Map(
    fs
      .readFileSync("/proc/self/io", "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(": ");
        return [key, Number(value)];
      }),
  );
  const values = {
    rchar: 0,
    wchar: 0,
    syscr: 0,
    syscw: 0,
    read_bytes: 0,
    write_bytes: 0,
    cancelled_write_bytes: 0,
  };
  for (const key of counters) {
    const value = fields.get(key);
    assert.ok(value !== undefined && Number.isSafeInteger(value) && value >= 0, key);
    values[key] = value;
  }
  return values;
}

export async function measureRuntimePinReadIo({
  command,
  expected,
  live,
}: {
  command: GatewayServiceCommandConfig;
  expected: DaemonRuntimePinSnapshot;
  live: boolean;
}) {
  const database = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(), { readOnly: true });
  let mmapBytes: unknown;
  try {
    // Observe the actual native default; never disable mmap to manufacture accounting.
    mmapBytes = database.prepare("PRAGMA mmap_size").get()?.mmap_size;
    assert.equal(mmapBytes, 0, "payload mmap would escape syscall-byte accounting");
  } finally {
    database.close();
  }
  const scope = {
    kind: "gateway" as const,
    env: process.env,
    ...(live ? { allowNativeRead: true as const } : {}),
  };
  const spawn = childProcess.spawnSync;
  let snapshotChildren = 0;
  childProcess.spawnSync = ((...args: Parameters<typeof spawn>) => {
    if (Array.isArray(args[1]) && args[1].includes(SQLITE_READONLY_CHILD_ARG)) {
      snapshotChildren += 1;
    }
    return spawn(...args);
  }) as typeof spawn;
  syncBuiltinESMExports();
  try {
    // Linux includes reaped spawnSync children. Adding their counters separately double-counts.
    const before = readIo();
    for (let index = 0; index < 3; index += 1) {
      assert.deepEqual(readDaemonRuntimePinForInstall(scope, command, false), expected);
      assertDaemonRuntimePinCurrent(scope, expected);
    }
    await closeStateDatabaseForTest();
    const after = readIo();
    const io = { ...after };
    for (const key of counters) {
      io[key] -= before[key];
    }
    return { snapshotChildren, mmapBytes, before, after, io };
  } finally {
    childProcess.spawnSync = spawn;
    syncBuiltinESMExports();
    await closeStateDatabaseForTest();
  }
}
