import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function source() {
  const pathname = path.join(dirs.make("openclaw-readonly-exclusion-"), "openclaw.sqlite");
  const owner = openOpenClawStateDatabase({ path: pathname });
  owner.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("readonly-exclusion", "preserved", "{}", 1);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

it("shares one online backup across concurrent snapshots of the live state owner", async () => {
  const pathname = source();
  const owner = openOpenClawStateDatabase({ path: pathname });
  owner.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("readonly-exclusion", "single-flight", "{}", 2);
  const sqlite = await import("../infra/node-sqlite.js").then((module) =>
    module.requireNodeSqlite(),
  );
  const backup = sqlite.backup.bind(sqlite);
  let backupCalls = 0;
  const started = createDeferredCore();
  const release = createDeferredCore();
  vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
    backupCalls += 1;
    started.resolve();
    await release.promise;
    return await backup(...args);
  });

  const firstSnapshot = prepareSqliteReadOnlyLocation(pathname);
  await started.promise;
  const secondSnapshot = prepareSqliteReadOnlyLocation(pathname);
  release.resolve();
  const [first, second] = await Promise.all([firstSnapshot, secondSnapshot]);
  try {
    expect(backupCalls).toBe(1);
    expect(first.location).toBe(second.location);
    expect(first.cleanup()).toBe(true);
    expect(fs.existsSync(second.location)).toBe(true);
    const snapshot = openNodeSqliteDatabase(second.location, { readOnly: true });
    try {
      expect(
        snapshot
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ? ORDER BY created_at")
          .all("readonly-exclusion"),
      ).toEqual([{ event_key: "preserved" }, { event_key: "single-flight" }]);
    } finally {
      snapshot.close();
    }
  } finally {
    await first.cleanupAsync();
    expect(await second.cleanupAsync()).toBe(true);
  }
  expect(fs.existsSync(second.location)).toBe(false);
});
