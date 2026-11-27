import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import * as snapshotStaging from "../infra/sqlite-snapshot-staging.js";
import { seedOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.test-support.js";
import { createDanglingSkillWorkshopReviewIndex } from "./openclaw-state-db-corruption.test-support.js";
import { checkOpenClawStateDatabaseRepairPending } from "./openclaw-state-db-repair-pending.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    cleanup();
  }),
);

/** A current state database with a second connection standing in for the serving Gateway. */
async function stateFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("state-repair-pending-") };
  const databasePath = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  const gateway = new DatabaseSync(databasePath);
  gateway.prepare("SELECT count(*) FROM sqlite_schema").get();
  return { env, databasePath, gateway };
}

/** Bytes, mtime and inode of the store; the -shm index changes on every read, so only its inode. */
function snapshotStore(databasePath: string) {
  const directory = path.dirname(databasePath);
  return [
    fs.readdirSync(directory).toSorted(),
    fs.statSync(directory, { bigint: true }).mode,
    ...[databasePath, `${databasePath}-wal`].map((file) => {
      const stat = fs.statSync(file, { bigint: true });
      return [file, fs.readFileSync(file).toString("base64"), stat.mtimeNs, stat.ino, stat.mode];
    }),
    fs.statSync(`${databasePath}-shm`, { bigint: true }).ino,
  ];
}

function decide(env: NodeJS.ProcessEnv, integrityCheck: "quick" | "full" = "quick") {
  return checkOpenClawStateDatabaseRepairPending({ env, integrityCheck });
}

function watchCopies() {
  return [
    vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectory"),
    vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectorySync"),
  ];
}

describe("checkOpenClawStateDatabaseRepairPending", () => {
  it("finds nothing on a healthy store and leaves it untouched", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    const copies = watchCopies();
    const before = snapshotStore(databasePath);

    expect(decide(env)).toBe("none");
    expect(decide(env, "full")).toBe("none");

    expect(snapshotStore(databasePath)).toEqual(before);
    for (const copy of copies) {
      expect(copy).not.toHaveBeenCalled();
    }
    gateway.close();
  });

  it("cannot decide a store no connection holds open, and creates no sidecars", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    gateway.close();
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    const files = fs.readdirSync(path.dirname(databasePath)).toSorted();

    expect(decide(env)).toBe("undecidable");

    expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(files);
  });

  it.skipIf(process.platform === "win32")(
    "reports a broadened file mode as work until the repair restores it",
    async () => {
      const { env, databasePath, gateway } = await stateFixture();
      fs.chmodSync(databasePath, 0o644);
      const before = snapshotStore(databasePath);

      expect(decide(env)).toBe("work");
      expect(snapshotStore(databasePath)).toEqual(before);

      await repairOpenClawStateDatabaseIndexesForDoctor({ env, integrityCheck: "quick" });
      expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
      expect(decide(env)).toBe("none");
      gateway.close();
    },
  );

  it("reports a quarantined store as work until the index repair clears it", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    seedOpenClawDatabaseQuarantine({
      env,
      kind: "state",
      path: databasePath,
      reason: "seeded integrity failure",
    });
    const before = snapshotStore(databasePath);

    expect(decide(env)).toBe("work");
    expect(snapshotStore(databasePath)).toEqual(before);

    const repaired = await repairOpenClawStateDatabaseIndexesForDoctor({
      env,
      integrityCheck: "quick",
    });
    expect(repaired.warnings).toEqual([]);
    expect(decide(env)).toBe("none");
    gateway.close();
  });

  it("reports orphan task delivery rows as work until readability repair preserves them", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    gateway.exec("PRAGMA foreign_keys = OFF");
    gateway
      .prepare(
        "INSERT INTO task_delivery_state (task_id, requester_origin_json, last_notified_event_at) VALUES ('orphan', '{}', 1)",
      )
      .run();
    const before = snapshotStore(databasePath);

    expect(decide(env)).toBe("work");
    expect(snapshotStore(databasePath)).toEqual(before);

    const repaired = await repairOpenClawStateDatabaseReadabilityForDoctor({ env });
    expect(repaired.changes).toEqual([
      expect.stringContaining("Preserved and recovered 1 orphan task delivery rows"),
    ]);
    expect(decide(env)).toBe("none");
    gateway.close();
  });

  it("decides damaged index keys with the integrity check the repair runs", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    gateway
      .prepare(
        "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('pendingprobe', 'ns', 'key', '{}', 1)",
      )
      .run();
    gateway.close();
    corruptSqliteIndexKey(databasePath, "idx_plugin_state_listing", "pendingprobe", "pendingprobf");
    const reader = new DatabaseSync(databasePath);
    reader.prepare("SELECT count(*) FROM sqlite_schema").get();
    const before = snapshotStore(databasePath);

    // quick_check does not compare index keys with rows; neither does the quick repair.
    expect(decide(env)).toBe("none");
    expect(decide(env, "full")).toBe("work");
    expect(snapshotStore(databasePath)).toEqual(before);

    const repaired = await repairOpenClawStateDatabaseIndexesForDoctor({
      env,
      integrityCheck: "full",
    });
    expect(repaired.changes.join("\n")).toContain("idx_plugin_state_listing");
    expect(decide(env, "full")).toBe("none");
    reader.close();
  });

  it("reports the dangling Skill Workshop review index as work until it is removed", async () => {
    const { env, databasePath, gateway } = await stateFixture();
    createDanglingSkillWorkshopReviewIndex(databasePath);
    const before = snapshotStore(databasePath);

    expect(decide(env)).toBe("work");
    expect(snapshotStore(databasePath)).toEqual(before);

    const repaired = await repairOpenClawStateDatabaseReadabilityForDoctor({ env });
    expect(repaired.changes).toEqual(["Removed dangling legacy Skill Workshop review index"]);
    expect(decide(env)).toBe("none");
    gateway.close();
  });
});
