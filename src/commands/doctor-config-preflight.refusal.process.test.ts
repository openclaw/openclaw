import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import {
  getCliProcessTestTimeout,
  runCliProcessChild,
} from "../cli/cli-process-child.test-helpers.js";
import { writeExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { registerLegacyDriverTests } from "./doctor-config-preflight.legacy-driver.test-support.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());
const DOCTOR_CHILD_TIMEOUT_MS = 60_000;
const approvalsSql = "SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'";

function fixture(prefix: string) {
  const root = fs.realpathSync(tempDirs.createTempDir(`openclaw-doctor-${prefix}-`));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(configPath, "{}\n");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    NO_COLOR: "1",
    CI: "1",
  };
  return { root, stateDir, configPath, env };
}

function runDoctor(root: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []) {
  return tempDirs.track(
    runBuiltRuntime(
      createBuiltRuntime(root),
      env,
      ["doctor", "--fix", "--non-interactive", ...extraArgs, "--no-workspace-suggestions"],
      DOCTOR_CHILD_TIMEOUT_MS,
    ),
  );
}

it("refuses missing deferral metadata with the 2026.9.2 row only in WAL", async () => {
  const { root, stateDir, configPath, env: childEnv } = fixture("update-wal");
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
  const shared = openOpenClawStateDatabase({ env }).path;
  createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
  closeOpenClawStateDatabaseForTest();
  const runtimeRoot = createBuiltRuntime(root, undefined, {
    copyDirectories: true,
    emptyExtensions: true,
  });
  const packagePath = path.join(runtimeRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, version: "2026.9.3" }));
  using writer = new DatabaseSync(shared);
  const row = writer.prepare("SELECT * FROM update_runs").get();
  if (!row) {
    throw new Error("Expected the fixture's update ledger row");
  }
  row.phase = "activating";
  writer.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          DROP TABLE config_machine_state;
          DELETE FROM update_runs;
          PRAGMA wal_checkpoint(TRUNCATE);
        `);
  const checkpoint = fs.readFileSync(shared);
  const columns = Object.keys(row);
  writer
    .prepare(
      `INSERT INTO update_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
  expect(fs.readFileSync(shared)).toEqual(checkpoint);
  expect(fs.statSync(`${shared}-wal`).size).toBeGreaterThan(32);
  const files = [shared, `${shared}-wal`, `${shared}-shm`, configPath];
  const before = files.map((file) => fs.readFileSync(file));

  // 2026.9.2 invokes the installed index directly and keeps its ledger open.
  const result = await tempDirs.track(
    runCliProcessChild({
      nodeExecutable: resolveTestNodeExecPath(),
      nodeArgs: [path.join(runtimeRoot, "dist/index.js"), "doctor", "--non-interactive", "--fix"],
      nodeArgsPolicy: "caller",
      cwd: runtimeRoot,
      timeoutMs: DOCTOR_CHILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        ...childEnv,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.3",
      },
    }),
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result, output).toMatchObject({ signal: null, code: 1 });
  expect(output).toContain("Doctor refused update-time schema repair driven by OpenClaw 2026.9.2");
  expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
}, 60_000);

it(
  "fails closed with manual recovery for an unsupported workspace and conflicting exec policy",
  async () => {
    const { root, stateDir, configPath, env } = fixture("unsupported-state");
    const workspaceDir = path.join(root, "workspace");
    const sourcePath = path.join(stateDir, "exec-approvals.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(workspaceDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: { workspace: workspaceDir } } },
        plugins: { enabled: false },
      }),
    );
    const legacy = JSON.stringify({ version: 1, defaults: { security: "full" }, agents: {} });
    fs.writeFileSync(sourcePath, legacy);
    const seeded = openOpenClawStateDatabase({ env });
    try {
      const identity = resolveWorkspaceStateIdentity(workspaceDir);
      seeded.db
        .prepare(
          "INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, updated_at) VALUES (?, ?, 99, 1)",
        )
        .run(identity.workspaceKey, identity.workspacePath);
      writeExecApprovalsConfigRow({
        db: seeded.db,
        file: { version: 1, defaults: { security: "deny" }, agents: {} },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
    const result = await runDoctor(root, env);
    const output = `${result.stdout}\n${result.stderr}`;
    const text = output.replaceAll("│", " ").replace(/\s+/g, " ");
    expect(result.code, output).toBe(1);
    expect(output).toContain(databasePath);
    expect(output).toContain(workspaceDir);
    expect(output).toContain(sourcePath);
    expect(text).toContain("unsupported workspace setup version 99");
    expect(text).toContain("compatible OpenClaw build");
    expect(text).toContain("reconcile this file");
    expect(text).not.toMatch(/(?:openclaw\s+)?doctor\s+--(?:fix|repair)/i);
    expect(output).not.toContain("Doctor complete.");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
    using db = new DatabaseSync(databasePath, { readOnly: true });
    expect(db.prepare("SELECT version FROM workspace_setup_state").all()).toEqual([
      { version: 99 },
    ]);
    expect(JSON.parse(String(db.prepare(approvalsSql).get()?.raw_json))).toMatchObject({
      defaults: { security: "deny" },
    });
  },
  getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
);

it(
  "stops the ordered graph at a refused TUI migration",
  async () => {
    const { root, stateDir, env } = fixture("refusal");
    const tuiPath = path.join(stateDir, "tui", "last-session.json");
    const approvalsPath = path.join(stateDir, "exec-approvals.json");
    fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
    fs.writeFileSync(tuiPath, "not json\n");
    fs.writeFileSync(approvalsPath, '{"version":1,"defaults":{"security":"allowlist"}}\n');
    const result = await runDoctor(root, env);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result, output).toMatchObject({ signal: null, code: 1 });
    using db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    expect(db.prepare(approvalsSql).all()).toEqual([]);
    expect(output).toContain("Failed reading legacy TUI last-session state");
  },
  getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
);

registerLegacyDriverTests([
  "managed pnpm partial metadata",
  "managed pnpm missing metadata run",
  "managed handoff mismatch",
  "managed handoff missing",
  "failed schema publication",
  "terminal post-core run",
  "missing post-core run",
]);
