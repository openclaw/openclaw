import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import * as sqliteBackup from "../infra/sqlite-backup.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const stateKey = "readonly.warm-source.fixture";
const valueJson = JSON.stringify({ source: "original native owner" });
const expectedReply = {
  ok: true,
  type: "tui.lastSession.read",
  sourceAdmitted: true,
  row: { value_json: valueJson, updated_at_ms: 1 },
};
const expectedSnapshotReply = {
  ...expectedReply,
  ...(getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources
    ? {}
    : { nativeCleanupFailure: { error: undefined } }),
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function createSource() {
  const root = tempDirs.make("openclaw-warm-read-source-");
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  const database = openOpenClawStateDatabase(options);
  database.db
    .prepare(
      "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run(stateKey, valueJson, 1);
  return { options, database };
}

function readSource(
  options: ReturnType<typeof createSource>["options"],
  preferIndependentWarmRead?: true,
) {
  return withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "tui.lastSession.read", stateKey },
      { preferIndependentWarmRead },
    ),
  );
}

it.each([false, true])(
  "reads the matching warm owner with independent-read opt-in=%s",
  async (independent) => {
    const { options, database } = createSource();
    const backup = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
    await expect(readSource(options, independent ? true : undefined)).resolves.toEqual(
      independent ? expectedReply : expectedSnapshotReply,
    );
    expect(backup).toHaveBeenCalledTimes(independent ? 0 : 1);
    if (!independent) {
      expect(backup.mock.calls[0]?.[0]).toBe(database.db);
    }
    expect(database.db.isOpen).toBe(true);
  },
);

// Windows SQLite handles do not allow renaming the open native database.
it.runIf(process.platform !== "win32")(
  "keeps the original native rows when its pathname has been replaced",
  async () => {
    const { options, database } = createSource();
    // Keep this fixture's committed bytes in its main file before moving the pathname.
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const originalPath = `${options.path}.original`;
    fs.renameSync(options.path, originalPath);
    const successor = "invalid successor; must never be opened or modified by this read";
    fs.writeFileSync(options.path, successor);
    const backup = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
    try {
      await expect(readSource(options, true)).resolves.toEqual(expectedSnapshotReply);
      expect(backup).toHaveBeenCalledOnce();
      expect(backup.mock.calls[0]?.[0]).toBe(database.db);
      expect(database.db.isOpen).toBe(true);
      expect(fs.readFileSync(options.path, "utf8")).toBe(successor);
    } finally {
      fs.rmSync(options.path);
      fs.renameSync(originalPath, options.path);
    }
  },
);

it("preserves native transaction refusal for the independent warm-read opt-in", async () => {
  const { options, database } = createSource();
  const backup = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
  database.db.exec("BEGIN");
  try {
    await expect(readSource(options, true)).rejects.toThrow(
      "Asynchronous shared-state reads cannot run inside a native transaction",
    );
    expect(database.db.isTransaction).toBe(true);
    expect(backup).not.toHaveBeenCalled();
  } finally {
    database.db.exec("ROLLBACK");
  }
});
