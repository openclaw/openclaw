import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("requires selected activation cleanup while preserving another engine and process", () => {
  const root = fs.realpathSync(dirs.make("survivor-context-activation-"));
  const state = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const databasePath = path.join(state, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(artifacts);
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE plugin_state_entries (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  ) STRICT`);
  database.close();
  const fixture = path.resolve("scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs");
  const node = resolveTestNodeExecPath();
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    NODE_OPTIONS: "--no-warnings",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
    OPENCLAW_UPGRADE_SURVIVOR_CONTEXT_ACTIVATION: "1",
  };
  const seeded = spawnSync(node, [fixture, "seed"], { env, encoding: "utf8" });
  expect(seeded.status, seeded.stderr).toBe(0);
  const entry = pathToFileURL(path.join(root, "custom-plugins", "memory", "index.mjs")).href;
  const result = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `import fs from 'node:fs';
       import { spawnSync } from 'node:child_process';
       import { DatabaseSync } from 'node:sqlite';
       const { default: plugin } = await import(${JSON.stringify(entry)});
       const registrations = [];
       plugin.register({
         registrationMode: 'full',
         config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8')),
         registerContextEngine(id) { registrations.push(id); },
       });
       const seed = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(artifacts, "sibling-activation-seed.json"))}, 'utf8'));
       const check = () => {
         const result = spawnSync(process.execPath, [${JSON.stringify(fixture)}, 'assert-activation'], { env: process.env, encoding: 'utf8' });
         return { status: result.status, stderr: result.stderr };
       };
       const results = [check()];
       const db = new DatabaseSync(seed.databasePath);
       const remove = db.prepare('DELETE FROM plugin_state_entries WHERE entry_key = ?');
       remove.run(seed.entries[0].key);
       results.push(check());
       remove.run(seed.entries[1].key);
       results.push(check());
       db.prepare('INSERT INTO plugin_state_entries VALUES (?, ?, ?, ?, ?, NULL)').run(
         'core:context-engine-quarantine-health', 'runtime-quarantines',
         seed.entries[1].key, seed.entries[1].value, Date.now());
       remove.run(seed.entries[2].key);
       results.push(check());
       db.close();
       console.log(JSON.stringify({ registrations, results }));`,
      "gateway",
    ],
    { env, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.registrations).toEqual(["survivor-sibling-memory"]);
  expect(output.results.map((observation: { status: number }) => observation.status)).toEqual([
    1, 0, 1, 1,
  ]);
  expect(output.results[0].stderr).toContain(
    "Ready Gateway retained its selected activation quarantine",
  );
  expect(output.results[2].stderr).toContain("Activation changed another engine");
  expect(output.results[3].stderr).toContain("Activation changed another process");
});
