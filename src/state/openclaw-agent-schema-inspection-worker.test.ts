import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("joins the schema reader before returning canceled ownership", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-cancellation-"), "source.sqlite");
  fs.writeFileSync(pathname, "");
  const controller = new AbortController();
  const reason = new Error("preflight ownership stopped");
  await using reader = createAgentSchemaInspectionWorker();
  const operation = reader.inspect({ pathname, supportedVersion: 1 }, controller.signal);
  const child = vi.mocked(fork).mock.results.at(-1)?.value;
  expect(child?.pid).toBeGreaterThan(0);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  const rejected = expect(operation).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  expect(closed).toBe(true);
});

it("reuses a process while rereading changed data and releasing each source lease", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-reuse-"), "source.sqlite");
  vi.mocked(fork).mockClear();
  await using reader = createAgentSchemaInspectionWorker();
  for (const version of [1, 2]) {
    const writer = sqlite.openNodeSqliteDatabase(pathname);
    writer.exec(`PRAGMA user_version=${version};`);
    writer.close();
    await expect(reader.inspect({ pathname, supportedVersion: 2 })).resolves.toMatchObject({
      version,
    });
    acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }).release();
  }
  expect(fork).toHaveBeenCalledOnce();
});

it("preserves a busy source failure without requesting another snapshot attempt", () => {
  const pathname = path.join(tempDirs.make("agent-schema-busy-"), "source.sqlite");
  const database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE probe(value TEXT);");
  database.close();
  const open = sqlite.openNodeSqliteDatabase;
  const busy = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const stub = vi
    .spyOn(sqlite, "openNodeSqliteDatabase")
    .mockImplementation((location, options) => {
      if (location === fs.realpathSync(pathname)) {
        throw busy;
      }
      return open(location, options);
    });
  try {
    expect(() => tryInspectSqliteReadOnlyInProcess(pathname, () => null)).toThrow(busy);
  } finally {
    stub.mockRestore();
  }
});
