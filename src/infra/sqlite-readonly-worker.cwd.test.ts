import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { sqliteReadOnlyWorkerRequestArgs } from "./sqlite-readonly-worker-protocol.js";
import {
  captureSqliteReadOnlyWorkerLaunch,
  createScopedSqliteReadOnlyWorker,
} from "./sqlite-readonly-worker.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-owner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("cold-starts an absolute SQLite snapshot when the invoking cwd is unavailable", async () => {
  const root = tempDirs.make("openclaw-sqlite-unavailable-cwd-");
  const source = path.join(root, "source.sqlite");
  const stagingRoot = path.join(root, "staging");
  fs.mkdirSync(stagingRoot);
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(source);
  writer.exec("CREATE TABLE witness (value TEXT); INSERT INTO witness VALUES ('preserved');");
  writer.close();
  const before = fs.readFileSync(source);
  const unavailable = new Error("ENOENT: invoking directory was removed");
  const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
    throw unavailable;
  });
  let worker: ReturnType<typeof createScopedSqliteReadOnlyWorker> | undefined;
  let witness: unknown;
  try {
    worker = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
    const location = await worker.run(source, { mode: "sync", stagingRoot });
    if (typeof location !== "string") {
      throw new Error("Snapshot worker did not return its absolute location");
    }
    const reader = new DatabaseSync(location, { readOnly: true });
    try {
      witness = reader.prepare("SELECT value FROM witness").get();
    } finally {
      reader.close();
    }
  } finally {
    cwd.mockRestore();
    await worker?.close();
  }
  expect(witness).toEqual({ value: "preserved" });
  expect(fs.readFileSync(source)).toEqual(before);
});

it.each(["source", "allocation", "staging"] as const)(
  "refuses unresolved relative %s paths instead of rebasing them after cwd loss",
  async (input) => {
    const source = path.join(tempDirs.make("openclaw-sqlite-relative-cwd-"), "source.sqlite");
    const unavailable = new Error("ENOENT: invoking directory was removed");
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw unavailable;
    });
    let observed: unknown;
    try {
      try {
        if (input === "source") {
          await startSqliteReadOnlyLocationAsync("relative.sqlite").result;
        } else if (input === "allocation") {
          await allocateWorkerOwnedSqliteSnapshotDirectory("relative-staging", false);
        } else {
          sqliteReadOnlyWorkerRequestArgs(source, {
            mode: "sync",
            stagingRoot: "relative-staging",
          });
        }
      } catch (error) {
        observed = error;
      }
    } finally {
      cwd.mockRestore();
    }
    expect(observed).toBe(unavailable);
  },
);
