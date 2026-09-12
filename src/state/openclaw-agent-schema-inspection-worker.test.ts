import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { inspectAgentDatabaseSchemaInWorker } from "./openclaw-agent-schema-inspection-worker.js";

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
  const operation = inspectAgentDatabaseSchemaInWorker(
    { pathname, supportedVersion: 1 },
    controller.signal,
  );
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
