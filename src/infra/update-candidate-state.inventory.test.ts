import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";
import { UpdateCandidateSnapshotInventorySchema } from "./update-candidate-state.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it.each([
  "install record",
  "locator symlink",
  "database registration",
  "added file",
  "enlarged file",
])("keeps snapshot bytes within inventory after %s changes", async (change) => {
  const root = dirs.make("candidate-inventory-drift-");
  const stateDir = path.join(root, "source");
  const inventoryRoot = path.join(root, "inventory");
  const targetStateDir = path.join(root, "snapshot");
  const candidateRoot = path.join(root, "candidate");
  await fs.mkdir(inventoryRoot);
  await fs.mkdir(candidateRoot);
  await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
  const writePlugin = async (project: string, size: number) => {
    const relative = path.join("npm", "projects", project, "node_modules", "@example", "demo");
    const directory = path.join(stateDir, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), '{"name":"@example/demo"}');
    await fs.writeFile(path.join(directory, "index.js"), "export default {};\n");
    const payload = await fs.open(path.join(directory, "payload.bin"), "w");
    try {
      await payload.truncate(size);
    } finally {
      await payload.close();
    }
    return { directory, relative };
  };
  const initial = await writePlugin("initial", 4096);
  const larger = await writePlugin("larger", 16 * 1024 * 1024);
  const locator = path.join(stateDir, "extensions", "demo");
  if (change === "locator symlink") {
    await fs.mkdir(path.dirname(locator));
    await fs.symlink(initial.directory, locator, "junction");
  }
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const setRecord = (installPath: string) => {
    const db = openOpenClawStateDatabase({ env }).db;
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json",
    ).run(
      "plugins.installedIndex",
      JSON.stringify({
        revision: 1,
        index: {
          installRecords: {
            demo: { source: "npm", spec: "@example/demo@1.0.0", installPath },
          },
        },
      }),
    );
    closeOpenClawStateDatabaseByPath(shared);
  };
  setRecord(change === "locator symlink" ? locator : initial.directory);
  let databaseInventory: string[] = [];
  const run = (mode: "inventory" | "snapshot") =>
    runCommandBuffered(
      [
        process.execPath,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
        ),
      ],
      {
        input: JSON.stringify({
          mode,
          stateDir,
          targetStateDir: mode === "inventory" ? inventoryRoot : targetStateDir,
          candidateRoot,
          config: {},
          env,
          databaseInventory,
          pluginPlanPath: path.join(inventoryRoot, UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME),
        }),
        timeoutMs: 30_000,
        killGraceMs: 500,
        maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      },
    );
  const inventoried = await run("inventory");
  expect(inventoried.code, inventoried.stderr.toString("utf8")).toBe(0);
  const inventory = UpdateCandidateSnapshotInventorySchema.parse(
    JSON.parse(inventoried.stdout.toString("utf8")),
  );
  databaseInventory = [...inventory.databases.keys()];
  expect(inventory.pluginBytes).toBeLessThan(16 * 1024 * 1024);
  let largerCopyPath = path.join(targetStateDir, larger.relative);
  if (change === "install record") {
    setRecord(larger.directory);
  } else if (change === "locator symlink") {
    await fs.unlink(locator);
    await fs.symlink(larger.directory, locator, "junction");
  } else if (change === "database registration") {
    const external = path.join(root, "late-agent.sqlite");
    const agentDb = openNodeSqliteDatabase(external);
    agentDb.exec(
      "PRAGMA user_version = 3; CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES (zeroblob(16777216));",
    );
    agentDb.close();
    const registry = openOpenClawStateDatabase({ env }).db;
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      )
      .run("late", external);
    closeOpenClawStateDatabaseByPath(shared);
    largerCopyPath = path.join(
      resolveUpdateCandidateStatePath(stateDir, targetStateDir, path.dirname(external)),
      path.basename(external),
    );
  } else {
    const name = change === "added file" ? "late.bin" : "payload.bin";
    const payload = await fs.open(path.join(initial.directory, name), "a");
    try {
      await payload.truncate(16 * 1024 * 1024);
    } finally {
      await payload.close();
    }
    largerCopyPath = path.join(targetStateDir, initial.relative, name);
  }
  const sourceDatabase = await fs.readFile(shared);
  const snapshot = await run("snapshot");
  const copiedNewOwner = await fs.access(largerCopyPath).then(
    () => true,
    () => false,
  );
  console.log(
    "Candidate plugin ownership drift",
    JSON.stringify({
      change,
      pluginBytes: inventory.pluginBytes,
      exitCode: snapshot.code,
      copiedNewOwner,
    }),
  );
  expect(await fs.readFile(shared)).toEqual(sourceDatabase);
  if (change === "added file") {
    expect(snapshot.code, snapshot.stderr.toString("utf8")).toBe(0);
  } else {
    expect(snapshot.code, "snapshot must refuse uninventoried bytes").not.toBe(0);
    expect(snapshot.stderr.toString("utf8")).toContain("changed after snapshot inventory");
  }
  expect(copiedNewOwner).toBe(false);
});
