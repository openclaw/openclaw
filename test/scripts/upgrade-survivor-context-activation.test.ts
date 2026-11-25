import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { AgentDefaultsSchema } from "../../src/config/zod-schema.agent-defaults.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("seeds sibling-plugin agent defaults accepted by the current schema", () => {
  const root = fs.realpathSync(dirs.make("survivor-sibling-config-"));
  const configPath = path.join(root, "state", "openclaw.json");
  const seeded = spawnSync(
    resolveTestNodeExecPath(),
    [path.resolve("scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs"), "seed"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: path.join(root, "artifacts"),
      },
    },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  expect(AgentDefaultsSchema.safeParse(config.agents.defaults).error).toBeUndefined();
});

it("requires installed Doctor evidence on activation and private evidence on legacy updates", () => {
  const root = fs.realpathSync(dirs.make("survivor-sibling-update-"));
  const state = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
  };
  const node = resolveTestNodeExecPath();
  const fixture = path.resolve("scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs");
  const run = (args: string[]) => spawnSync(node, args, { env, encoding: "utf8" });
  const seeded = run([fixture, "seed"]);
  expect(seeded.status, seeded.stderr).toBe(0);
  const receipt = path.join(artifacts, "update.json");
  const steps = [
    { name: "openclaw doctor", exitCode: 0 },
    { name: "update-driver-handoff", exitCode: 0 },
  ];
  fs.writeFileSync(receipt, JSON.stringify({ status: "ok", steps }));
  const check = () => run([fixture, "assert-update-imports", receipt]);
  expect(check().stderr).toContain("Installed Doctor did not execute the sibling plugin contract");

  const doctor = pathToFileURL(
    path.join(root, "custom-plugins", "memory", "doctor-contract-api.mjs"),
  ).href;
  const execute = run([
    "--input-type=module",
    "-e",
    `const doctor = await import(${JSON.stringify(doctor)}); doctor.normalizeCompatibilityConfig({ cfg: {} });`,
  ]);
  expect(execute.status, execute.stderr).toBe(0);
  const activated = check();
  expect(activated.status, activated.stderr).toBe(0);

  steps.push({ name: "candidate-doctor-lint", exitCode: 0 });
  fs.writeFileSync(receipt, JSON.stringify({ status: "ok", steps }));
  expect(check().stderr).toContain(
    "No custom plugin Doctor contract execution from the private update canary",
  );
  const privateState = path.join(root, "openclaw-update-canary-fixture");
  fs.cpSync(path.join(root, "custom-plugins"), privateState, { recursive: true });
  const privateDoctor = pathToFileURL(
    path.join(privateState, "memory", "doctor-contract-api.mjs"),
  ).href;
  const privateRuntime = pathToFileURL(path.join(privateState, "memory", "index.mjs")).href;
  const canary = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `const doctor = await import(${JSON.stringify(privateDoctor)});
       doctor.normalizeCompatibilityConfig({ cfg: {} });
       const { default: plugin } = await import(${JSON.stringify(privateRuntime)});
       plugin.register({ registerContextEngine() {} });`,
      "--",
      "gateway",
      "--update-canary",
    ],
    { env: { ...env, OPENCLAW_STATE_DIR: privateState }, encoding: "utf8" },
  );
  expect(canary.status, canary.stderr).toBe(0);
  const legacy = check();
  expect(legacy.status, legacy.stderr).toBe(0);
});

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
       const registrationPath = ${JSON.stringify(path.join(artifacts, "sibling-registrations.jsonl"))};
       const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
       fs.writeFileSync(registrationPath, JSON.stringify({ ...registration, pid: process.pid + 1 }));
       results.push(check());
       console.log(JSON.stringify({ registrations, results }));`,
      "gateway",
    ],
    { env, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.registrations).toEqual(["survivor-sibling-memory"]);
  expect(output.results.map((observation: { status: number }) => observation.status)).toEqual([
    1, 0, 1, 1, 1,
  ]);
  expect(output.results[0].stderr).toContain(
    "Ready Gateway retained its selected activation quarantine",
  );
  expect(output.results[2].stderr).toContain("Activation changed another engine");
  expect(output.results[3].stderr).toContain("Activation changed another process");
  expect(output.results[4].stderr).toContain("Ready Gateway did not register the sibling plugin");
});
