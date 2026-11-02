import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import * as sqliteBackup from "../infra/sqlite-backup.js";
import * as reads from "./openclaw-state-db-readonly.js";
import * as state from "./openclaw-state-db.js";

const stateKey = "readonly.warm-source.fixture";
const request = { type: "tui.lastSession.read", stateKey } as const;
const insert =
  "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?)";
const valueJson = JSON.stringify({ source: "original native owner" });
const expectedReply = {
  ok: true,
  type: "tui.lastSession.read",
  sourceAdmitted: true,
  row: { value_json: valueJson, updated_at_ms: 1 },
};
const expectedSnapshotReply = getSqliteRuntimeCapabilities()
  .explicitSqliteCloseReleasesNativeResources
  ? expectedReply
  : { ...expectedReply, nativeCleanupFailure: { error: undefined } };
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await state.closeOpenClawStateDatabaseAsync();
    state.closeOpenClawStateDatabaseForTest();
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
  const database = state.openOpenClawStateDatabase(options);
  database.db.prepare(insert).run(stateKey, valueJson, 1);
  const backup = vi.spyOn(sqliteBackup, "backupNodeSqliteDatabase");
  const read = (preferIndependentWarmRead?: true) =>
    reads.withArtifactPreservingStateReads(() =>
      reads.executeExistingOpenClawStateRead(options, request, { preferIndependentWarmRead }),
    );
  const verifyRead = async (independent: boolean, snapshot = !independent) => {
    await expect(read(independent ? true : undefined)).resolves.toEqual(
      snapshot ? expectedSnapshotReply : expectedReply,
    );
    expect(backup).toHaveBeenCalledTimes(snapshot ? 1 : 0);
    if (snapshot) {
      expect(backup.mock.calls[0]?.[0]).toBe(database.db);
    }
    expect(database.db.isOpen).toBe(true);
  };
  return { options, database, backup, read, verifyRead };
}

it.each([false, true])("reads the warm owner (independent=%s)", (independent) =>
  createSource().verifyRead(independent),
);

// Windows SQLite handles do not allow renaming the open native database.
it.runIf(process.platform !== "win32")(
  "keeps the original native rows when its pathname has been replaced",
  async () => {
    const { options, database, verifyRead } = createSource();
    // Keep this fixture's committed bytes in its main file before moving the pathname.
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const originalPath = `${options.path}.original`;
    fs.renameSync(options.path, originalPath);
    const successor = "invalid successor; must never be opened or modified by this read";
    fs.writeFileSync(options.path, successor);
    try {
      await verifyRead(true, true);
      expect(fs.readFileSync(options.path, "utf8")).toBe(successor);
    } finally {
      fs.rmSync(options.path);
      fs.renameSync(originalPath, options.path);
    }
  },
);

it("preserves native transaction refusal for the independent warm-read opt-in", async () => {
  const { database, backup, read } = createSource();
  database.db.exec("BEGIN");
  using _ = { [Symbol.dispose]: () => database.db.exec("ROLLBACK") };
  await expect(read(true)).rejects.toThrow(
    "Asynchronous shared-state reads cannot run inside a native transaction",
  );
  expect(database.db.isTransaction).toBe(true);
  expect(backup).not.toHaveBeenCalled();
});
