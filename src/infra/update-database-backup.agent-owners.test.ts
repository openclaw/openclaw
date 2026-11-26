import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("records agent folders under canonical ids for the recovery manifest", async () => {
  const root = await fs.realpath(dirs.make("update-backup-agent-owners-"));
  const stateDir = path.join(root, "state");
  const backupRoot = path.join(root, "retained");
  const stagingRoot = path.join(root, "scratch");
  const database = (folder: string) =>
    path.join(stateDir, "agents", folder, "agent", "openclaw-agent.sqlite");
  for (const parent of [path.join(stateDir, "state"), `${backupRoot}.databases`, stagingRoot]) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  }
  using shared = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"));
  shared.exec("PRAGMA user_version=17; CREATE TABLE agent_databases(path TEXT)");
  for (const [folder, agentId] of [
    ["BA-EA", "ba-ea"],
    ["_ops", "_ops"],
    ["!!!", "main"],
  ] as const) {
    await fs.mkdir(path.dirname(database(folder)), { recursive: true, mode: 0o700 });
    using db = new DatabaseSync(database(folder));
    db.exec(
      "PRAGMA user_version=17; CREATE TABLE schema_meta(meta_key TEXT, role TEXT, agent_id TEXT, schema_version INTEGER)",
    );
    db.prepare("INSERT INTO schema_meta VALUES ('primary','agent',?,17)").run(agentId);
  }
  const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  const backup = await createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan });
  const owners = backup.databaseOwners?.filter(({ role }) => role === "agent");
  // "!!!" would normalize to main: its bytes are captured, but it names no agent.
  expect(owners).toEqual(
    expect.arrayContaining([
      { path: database("BA-EA"), role: "agent", agentId: "ba-ea" },
      { path: database("_ops"), role: "agent", agentId: "_ops" },
    ]),
  );
  expect(owners?.some(({ path: file }) => file === database("!!!"))).toBe(false);
  expect(backup.databases.map((entry) => entry.path)).toContain(database("!!!"));
});
