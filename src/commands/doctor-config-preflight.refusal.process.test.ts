import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { disableUpdatedPackageCompileCacheEnv } from "../cli/update-cli/update-command-service-env.js";
import {
  createUpdatePostInstallDoctorResultPath,
  consumeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());
const DOCTOR_CHILD_TIMEOUT_MS = 60_000;
let unmanagedRollbackRuntimeRoot: string | undefined;

function createRollbackRuntime(root: string): string {
  const runtimeRoot = createBuiltRuntime(root, undefined, { copyDirectories: true });
  // Rehearsal clears environment overrides, so this core-only fixture owns an empty plugin tree.
  const extensionsDir = path.join(runtimeRoot, "dist", "extensions");
  fs.rmSync(extensionsDir, { recursive: true, force: true });
  fs.mkdirSync(extensionsDir);
  return runtimeRoot;
}

describe("Doctor CLI migration refusal", () => {
  it.each(["index.js", "entry.js"])(
    "refuses missing deferral metadata through %s with the 2026.9.2 row only in WAL",
    (entry) => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-update-wal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
      fs.writeFileSync(configPath, "{}\n");
      const shared = openOpenClawStateDatabase({ env }).path;
      createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
      closeOpenClawStateDatabaseForTest();
      const runtimeRoot = createBuiltRuntime(root, undefined, { copyDirectories: true });
      const packagePath = path.join(runtimeRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, version: "2026.9.3" }));
      const writer = new DatabaseSync(shared);
      try {
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
        writer
          .prepare(
            `INSERT INTO update_runs (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(row));
        expect(fs.readFileSync(shared)).toEqual(checkpoint);
        expect(fs.statSync(`${shared}-wal`).size).toBeGreaterThan(32);
        const files = [shared, `${shared}-wal`, `${shared}-shm`, configPath];
        const before = files.map((file) => fs.readFileSync(file));

        // 2026.9.2 invokes the installed index directly and keeps its ledger open.
        const result = spawnSync(
          process.execPath,
          [path.join(runtimeRoot, "dist", entry), "doctor", "--non-interactive", "--fix"],
          {
            cwd: runtimeRoot,
            encoding: "utf8",
            timeout: 60_000,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              USERPROFILE: root,
              ...env,
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.3",
              OPENCLAW_SERVICE_REPAIR_POLICY: "external",
              NO_COLOR: "1",
              CI: "1",
            },
          },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(1);
        expect(output).toContain(
          "Doctor refused update-time schema repair driven by OpenClaw 2026.9.2",
        );
        expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
        expect(writer.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION - 1,
        );
        expect(writer.prepare("SELECT * FROM update_runs").get()).toEqual(row);
      } finally {
        writer.close();
      }
    },
    60_000,
  );

  it(
    "fails closed with manual recovery for an unsupported workspace and conflicting exec policy",
    async () => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-unsupported-state-"));
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const sourcePath = path.join(stateDir, "exec-approvals.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(stateDir, { recursive: true });
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
      const runtimeRoot = createBuiltRuntime(root);
      await runIsolatedModuleScript(
        env,
        `
      import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from "./src/state/openclaw-state-db.ts";
      import { resolveWorkspaceStateIdentity } from "./src/agents/workspace-state-identity.ts";
      import { writeExecApprovalsConfigRow } from "./src/infra/exec-approvals-sqlite.ts";
      const { db } = openOpenClawStateDatabase();
      const identity = resolveWorkspaceStateIdentity(${JSON.stringify(workspaceDir)});
      db.prepare("INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, updated_at) VALUES (?, ?, 99, 1)").run(identity.workspaceKey, identity.workspacePath);
      writeExecApprovalsConfigRow({ db, file: { version: 1, defaults: { security: "deny" }, agents: {} } });
      closeOpenClawStateDatabaseForTest();
    `,
        { runtimeRoot, timeoutMs: DOCTOR_CHILD_TIMEOUT_MS },
      );
      const result = await tempDirs.track(
        runBuiltRuntime(
          runtimeRoot,
          env,
          ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
          DOCTOR_CHILD_TIMEOUT_MS,
        ),
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const text = output.replaceAll("│", " ").replace(/\s+/g, " ");
      expect(result.code, output).toBe(1);
      expect(output).toContain(databasePath);
      expect(output).toContain(workspaceDir);
      expect(text).toContain("unsupported workspace setup version 99");
      expect(text).toContain("compatible OpenClaw build");
      expect(output).toContain(sourcePath);
      expect(text).toContain("reconcile this file");
      expect(text).not.toMatch(/(?:openclaw\s+)?doctor\s+--(?:fix|repair)/i);
      expect(output).not.toContain("Doctor complete.");
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(db.prepare("SELECT version FROM workspace_setup_state").all()).toEqual([
          { version: 99 },
        ]);
        const policy = db
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .get();
        expect(JSON.parse(String(policy?.raw_json))).toMatchObject({
          defaults: { security: "deny" },
        });
      } finally {
        db.close();
      }
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS, DOCTOR_CHILD_TIMEOUT_MS),
  );

  it.each([false, true])(
    "honors the ordered graph with valid TUI=%s",
    async (validTui) => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const tuiRaw = validTui
        ? JSON.stringify({
            terminal: { sessionKey: "agent:main:tui:behavior-validator", updatedAt: 100 },
          }) + "\n"
        : "not json\n";
      const approvalsRaw =
        JSON.stringify({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss" },
          agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
        }) + "\n";
      fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
      fs.writeFileSync(configPath, "{}\n");
      fs.writeFileSync(tuiPath, tuiRaw);
      fs.writeFileSync(approvalsPath, approvalsRaw);
      const runtimeRoot = createBuiltRuntime(root);
      const result = await tempDirs.track(
        runBuiltRuntime(
          runtimeRoot,
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            NO_COLOR: "1",
            CI: "1",
          },
          ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
          DOCTOR_CHILD_TIMEOUT_MS,
        ),
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.signal, output).toBeNull();
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const approvals = db
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .all();
        if (validTui) {
          expect(result.code, output).toBe(0);
          expect(output).toContain("Doctor complete.");
          expect(output.indexOf("TUI last-session pointer(s)")).toBeGreaterThanOrEqual(0);
          expect(output.indexOf("Imported legacy exec approvals")).toBeGreaterThan(
            output.indexOf("TUI last-session pointer(s)"),
          );
          expect(fs.existsSync(tuiPath)).toBe(false);
          expect(fs.existsSync(approvalsPath)).toBe(false);
          expect(approvals).toHaveLength(1);
        } else {
          expect(fs.existsSync(approvalsPath), output).toBe(true);
          expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsRaw);
          expect(fs.readFileSync(tuiPath, "utf8")).toBe(tuiRaw);
          expect(approvals).toEqual([]);
          expect(result.code, output).toBe(1);
          expect(output).toContain("Failed reading legacy TUI last-session state");
          expect(output).not.toContain("Imported legacy exec approvals");
          expect(output).not.toContain("Doctor complete.");
          expect(output).not.toContain("rerun doctor --fix");
        }
      } finally {
        db.close();
      }
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );
});

describe("Doctor CLI config recovery", () => {
  it("repairs retired and unknown keys and migrates legacy state with the system agent in one run", async () => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-config-state-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    const sessionsDir = path.join(stateDir, "sessions");
    const workspaceSource = path.join(workspaceDir, ".openclaw", "workspace-state.json");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "digest" } },
          entries: { other: {}, digest: { workspace: workspaceDir } },
        },
        browser: { relayBindHost: "127.0.0.1", obsoleteSetting: true },
        commands: { modelsWrite: true },
        gateway: { mode: "local", auth: { mode: "none" } },
        plugins: { enabled: false },
      }),
    );
    const completedAt = "2026-09-01T12:00:00.000Z";
    fs.writeFileSync(
      workspaceSource,
      JSON.stringify({ version: 1, setupCompletedAt: completedAt }),
    );
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ legacy: { sessionId: "legacy-session", updatedAt: 1 } }),
    );
    fs.writeFileSync(path.join(sessionsDir, "legacy-session.jsonl"), "{}\n");
    const runtimeRoot = createBuiltRuntime(root);
    const result = await tempDirs.track(
      runBuiltRuntime(
        runtimeRoot,
        {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          NO_COLOR: "1",
          CI: "1",
        },
        ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
        60_000,
      ),
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code, output).toBe(0);
    expect(output).toContain("Doctor complete.");
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(repaired.browser).not.toHaveProperty("relayBindHost");
    expect(repaired.browser).not.toHaveProperty("obsoleteSetting");
    expect(repaired.commands).not.toHaveProperty("modelsWrite");
    expect(repaired.agents.defaults.systemAgent.agentId).toBe("digest");
    expect(fs.existsSync(workspaceSource)).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, "sessions.json"))).toBe(false);
    const agentDb = new DatabaseSync(
      path.join(stateDir, "agents", "digest", "agent", "openclaw-agent.sqlite"),
      { readOnly: true },
    );
    try {
      expect(agentDb.prepare("SELECT current_session_id FROM session_nodes").all()).toContainEqual({
        current_session_id: "legacy-session",
      });
    } finally {
      agentDb.close();
    }
    const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(db.prepare("SELECT setup_completed_at FROM workspace_setup_state").all()).toEqual([
        { setup_completed_at: completedAt },
      ]);
    } finally {
      db.close();
    }
  }, 75_000);
});

it.each([
  "valid",
  "valid managed v1",
  "valid managed pnpm",
  "managed pnpm missing metadata",
  "managed pnpm partial metadata",
  "managed pnpm missing metadata run",
  "managed handoff mismatch",
  "managed handoff missing",
  "failed schema publication",
  "terminal post-core run",
  "missing post-core run",
] as const)(
  "keeps the shipped 9.2 rollback window read-only and validates private state: %s",
  async (mode) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: {
          // Published 2026.9.2 update-command-package.ts sets these, including DEFER=1.
          ...buildUpdateDoctorEnv({
            allowGatewayServiceRepair: false,
            allowGatewayActivation: false,
            deferConfiguredPluginInstallRepair: true,
            serviceRepairPolicy: "external",
            compatibilityHostVersion: VERSION,
          }),
          OPENCLAW_UPDATE_POST_CORE: undefined,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        await state.writeConfig({
          plugins: { enabled: false },
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: state.workspaceDir } },
          },
          gateway: { mode: "local", auth: { mode: "none" } },
        });
        const agentPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
        const sharedPath = openOpenClawStateDatabase().path;
        const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
        recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "in_progress" });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const legacy = new DatabaseSync(agentPath);
        try {
          restoreEmptyV21StorageForHistoricalFixture(legacy);
          removeCanonicalValidationFromHistoricalAgentFixture(legacy);
          legacy.exec(`DROP TABLE session_transcript_cold_archives;
          PRAGMA user_version = 19;
          UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
          INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
            VALUES ('upgrade-proof','retained','{"keep":true}',NULL,7);
          INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
            VALUES ('agent:main:history','window-1','{"sessionId":"window-1","updatedAt":20}',20);
          INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
            VALUES ('window-1','agent:main:history',10,20);
          INSERT INTO transcript_events (session_id,seq,event_json,created_at)
            VALUES ('window-1',7,'{ "type": "message", "text": "retained bytes 雪" }',11);`);
          if (mode === "failed schema publication") {
            legacy.exec(`CREATE TRIGGER reject_schema_publication BEFORE UPDATE ON schema_meta
              WHEN NEW.schema_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}
              BEGIN SELECT RAISE(ABORT, 'fixture schema publication failure'); END;`);
          }
        } finally {
          legacy.close();
        }
        const originals = [agentPath, sharedPath, state.configPath];
        const bytes = originals.map((file) => fs.readFileSync(file));
        const malformedHandoff = mode.startsWith("managed pnpm ");
        const managed =
          mode === "valid managed v1" ||
          mode === "valid managed pnpm" ||
          malformedHandoff ||
          mode === "managed handoff mismatch" ||
          mode === "managed handoff missing";
        const relocatesRuntime = mode === "valid managed pnpm" || malformedHandoff;
        // Managed handoff authority includes the install path, so keep those packages private.
        let runtimeRoot = managed
          ? createRollbackRuntime(state.root)
          : (unmanagedRollbackRuntimeRoot ??= createRollbackRuntime(
              fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-rollback-runtime-")),
            ));
        let managedRoot = runtimeRoot;
        if (relocatesRuntime) {
          const project = state.path("pnpm", "global", "5");
          const previous = path.join(
            project,
            ".pnpm",
            "openclaw@2026.9.2",
            "node_modules",
            "openclaw",
          );
          const current = path.join(
            project,
            ".pnpm",
            `openclaw@${VERSION}`,
            "node_modules",
            "openclaw",
          );
          fs.mkdirSync(path.dirname(current), { recursive: true });
          fs.renameSync(runtimeRoot, current);
          runtimeRoot = fs.realpathSync(current);
          fs.mkdirSync(previous, { recursive: true });
          fs.writeFileSync(
            path.join(previous, "package.json"),
            JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
          );
          fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
          fs.writeFileSync(
            path.join(project, "node_modules", ".modules.yaml"),
            "layoutVersion: 5\n",
          );
          fs.writeFileSync(
            path.join(project, "package.json"),
            JSON.stringify({ dependencies: { openclaw: VERSION } }),
          );
          fs.symlinkSync(
            current,
            path.join(project, "node_modules", "openclaw"),
            process.platform === "win32" ? "junction" : "dir",
          );
          managedRoot = fs.realpathSync(previous);
        }
        // Rehearsal preserves these exact bytes. Exercise both package layouts once;
        // the remaining variants differ only at the post-core boundary below.
        if (
          mode === "valid" ||
          mode === "valid managed pnpm" ||
          mode === "failed schema publication"
        ) {
          const resultPath = createUpdatePostInstallDoctorResultPath();
          // The shipped updater disables compile caching before both child handoffs.
          const result = await runBuiltRuntime(
            runtimeRoot,
            disableUpdatedPackageCompileCacheEnv({
              ...process.env,
              OPENCLAW_DEBUG_PROXY_ENABLED: "1",
              [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath,
              NODE_ENV: undefined,
              VITEST: undefined,
              VITEST_POOL_ID: undefined,
              VITEST_WORKER_ID: undefined,
            }),
            ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
            DOCTOR_CHILD_TIMEOUT_MS,
          );
          const output = `${result.stdout}\n${result.stderr}`;
          const receipt = await consumeUpdatePostInstallDoctorResult(resultPath);
          expect(result.signal, output).toBeNull();
          expect(
            originals.map((file) => fs.readFileSync(file)),
            output,
          ).toEqual(bytes);
          if (mode === "failed schema publication") {
            expect(result.code, output).toBe(1);
            expect(output).toContain("Private Doctor schema validation failed");
            expect(output).toContain("Failing check media-persistence (step-refused)");
            expect(output).not.toContain("Repair is deferred");
            return;
          }
          expect(result.code, output).toBe(0);
          expect(receipt).toMatchObject({
            status: "ok",
            configHash: "unchanged",
            warnings: [expect.stringContaining("live agent databases are unchanged")],
          });
          expect(output).toContain("live agent databases are unchanged");
          expect(output).not.toContain("Doctor complete.");
        }
        // The published driver has now discarded package rollback and recorded its
        // fresh post-core boundary. Only the native child can carry live authority.
        recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
        recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
        if (mode === "terminal post-core run") {
          finishUpdateRun(run.runId, { status: "failed", reason: "fixture-parent-stopped" });
        }
        const beforeResume = getUpdateRun(run.runId);
        const success =
          mode === "valid" || mode === "valid managed v1" || mode === "valid managed pnpm";
        const metaPath = state.path("handoff-meta.json");
        let managedRow: { owner: string; payload_json: string; updated_at: number } | undefined;
        if (managed) {
          const store = createManagedHandoffLeaseStore();
          const initialized = store.acquire(managedRoot, run.runId, { kind: "update" });
          if (initialized.kind !== "acquired" || !store.release(initialized.lease)) {
            throw new Error("Could not initialize isolated fixture handoff");
          }
          const { pid, startIdentity } = store.processIdentity();
          managedRow = {
            owner: "shipped-owner",
            payload_json: JSON.stringify({ version: 1, pid, startIdentity }),
            updated_at: 7,
          };
          const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
          try {
            db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
              managedRoot,
              managedRow.owner,
              managedRow.payload_json,
              managedRow.updated_at,
            );
          } finally {
            db.close();
          }
          if (mode !== "managed pnpm missing metadata") {
            fs.writeFileSync(
              metaPath,
              JSON.stringify({
                version: 1,
                meta: {
                  runId: mode === "managed pnpm missing metadata run" ? undefined : run.runId,
                  root: mode === "managed pnpm partial metadata" ? undefined : managedRoot,
                  handoffId:
                    mode === "managed handoff mismatch" ? "another-owner" : managedRow.owner,
                },
              }),
            );
          }
        }
        if (mode === "managed handoff missing") {
          const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
          db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(managedRoot);
          db.close();
        }
        const resume = () =>
          runBuiltRuntime(
            runtimeRoot,
            disableUpdatedPackageCompileCacheEnv({
              ...process.env,
              OPENCLAW_UPDATE_POST_CORE: "1",
              OPENCLAW_UPDATE_RUN_HANDOFF: managed ? "1" : undefined,
              ...(managed ? { OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: metaPath } : {}),
              OPENCLAW_UPDATE_RUN_ID:
                mode === "missing post-core run"
                  ? "53e56de0-a951-4b3d-af1a-9e4f1ac5a069"
                  : run.runId,
              OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: state.path("post-core-result.json"),
              OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now()),
              NODE_ENV: undefined,
              VITEST: undefined,
              VITEST_POOL_ID: undefined,
              VITEST_WORKER_ID: undefined,
            }),
            ["update", "--json", "--yes", "--no-restart"],
            DOCTOR_CHILD_TIMEOUT_MS,
          );
        const resumed = await resume();
        if (mode === "valid managed v1" && resumed.code === 0) {
          const current = new DatabaseSync(agentPath, { readOnly: true });
          try {
            expect(current.prepare("PRAGMA user_version").get()?.user_version).toBe(
              OPENCLAW_AGENT_SCHEMA_VERSION,
            );
          } finally {
            current.close();
          }
          // A current-schema continuation must retain the same live parent
          // without requiring another migration or a new update-history row.
          const sameSchema = await resume();
          expect(sameSchema.code, `${sameSchema.stdout}\n${sameSchema.stderr}`).toBe(0);
        }
        if (managedRow) {
          const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
          try {
            expect(
              db
                .prepare(
                  "SELECT owner,payload_json,updated_at FROM managed_update_handoffs WHERE install_root = ?",
                )
                .get(managedRoot),
            ).toEqual(mode === "managed handoff missing" ? undefined : managedRow);
            if (managedRoot !== runtimeRoot) {
              expect(
                db
                  .prepare(
                    "SELECT COUNT(*) AS count FROM managed_update_handoffs WHERE instr(install_root, ?) = 1",
                  )
                  .get(runtimeRoot)?.count,
              ).toBe(0);
            }
            expect(
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM managed_update_handoffs WHERE instr(install_root, ?) = 1",
                )
                .get(`${managedRoot}/.openclaw-update-child-`)?.count,
            ).toBe(0);
          } finally {
            db.prepare(
              "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
            ).run(managedRoot, managedRow.owner);
            db.close();
          }
        }
        expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(success ? 0 : 1);
        expect(listUpdateRuns({ limit: 100 }).map((entry) => entry.runId)).toEqual([run.runId]);
        expect(getUpdateRun(run.runId)).toMatchObject({
          status: beforeResume?.status,
          before: beforeResume?.before,
          origin: beforeResume?.origin,
          phase: beforeResume?.phase,
        });
        if (!success) {
          if (malformedHandoff) {
            expect(`${resumed.stdout}\n${resumed.stderr}`).toContain(
              "Legacy managed post-core handoff is incomplete or names another update run.",
            );
          }
          expect(fs.readFileSync(agentPath)).toEqual(bytes[0]);
          return;
        }
        const repaired = new DatabaseSync(agentPath, { readOnly: true });
        try {
          expect(repaired.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          expect(repaired.prepare("SELECT value_json,updated_at FROM cache_entries").all()).toEqual(
            [{ value_json: '{"keep":true}', updated_at: 7 }],
          );
          expect(repaired.prepare("SELECT event_json,seq FROM transcript_events").all()).toEqual([
            { event_json: '{ "type": "message", "text": "retained bytes 雪" }', seq: 7 },
          ]);
        } finally {
          repaired.close();
        }
      },
    );
  },
  getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS, DOCTOR_CHILD_TIMEOUT_MS),
);
