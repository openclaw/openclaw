import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readUpdateCandidateStateInventoryInProcess } from "./update-candidate-state.js";
import { snapshotUpdateCandidateState } from "./update-candidate-state.snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves sparse row IDs and original bytes when preparing a migration rehearsal", async () => {
  const root = tempDirs.make("candidate-rowids-");
  const stateDir = path.join(root, "source");
  const targetStateDir = path.join(root, "rehearsal");
  const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
  const source = path.join(stateDir, relative);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(targetStateDir);
  const db = openNodeSqliteDatabase(source);
  try {
    db.exec(`
        PRAGMA user_version = 3;
        CREATE TABLE evidence(value TEXT);
        INSERT INTO evidence(rowid, value) VALUES(71, 'preserved');
      `);
  } finally {
    db.close();
  }
  const original = await fs.readFile(source);
  const input = {
    stateDir,
    targetStateDir,
    candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
    config: {},
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
    },
  };
  const inventory = await readUpdateCandidateStateInventoryInProcess(input);
  await snapshotUpdateCandidateState({
    ...input,
    pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
    databaseInventory: [...inventory.databases.keys()],
  });
  const snapshot = openNodeSqliteDatabase(path.join(targetStateDir, relative), {
    readOnly: true,
  });
  try {
    expect(snapshot.prepare("SELECT rowid, value FROM evidence").all()).toEqual([
      { rowid: 71, value: "preserved" },
    ]);
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(snapshot.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  } finally {
    snapshot.close();
  }
  expect(await fs.readFile(source)).toEqual(original);
});
