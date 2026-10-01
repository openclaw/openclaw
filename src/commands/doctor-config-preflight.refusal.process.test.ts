import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { writeExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { registerLegacyDriverTests } from "./doctor-config-preflight.legacy-driver.test-support.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runIsolatedModuleScript,
  runBuiltRuntime,
  seedV17AdditiveRepairDatabase,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());
const DOCTOR_CHILD_TIMEOUT_MS = 60_000;

describe("Doctor CLI migration refusal", () => {
  it("refuses missing deferral metadata with the 2026.9.2 row only in WAL", () => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-update-wal-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
    fs.writeFileSync(configPath, "{}\n");
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
        [path.join(runtimeRoot, "dist", "index.js"), "doctor", "--non-interactive", "--fix"],
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
  }, 60_000);

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
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );

  it(
    "stops the ordered graph at a refused TUI migration",
    async () => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const tuiRaw = "not json\n";
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
        expect(fs.existsSync(approvalsPath), output).toBe(true);
        expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsRaw);
        expect(fs.readFileSync(tuiPath, "utf8")).toBe(tuiRaw);
        expect(approvals).toEqual([]);
        expect(result.code, output).toBe(1);
        expect(output).toContain("Failed reading legacy TUI last-session state");
        expect(output).not.toContain("Imported legacy exec approvals");
        expect(output).not.toContain("Doctor complete.");
        expect(output).not.toContain("rerun doctor --fix");
      } finally {
        db.close();
      }
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );
});

registerLegacyDriverTests([
  "managed pnpm missing metadata",
  "managed pnpm partial metadata",
  "managed pnpm missing metadata run",
  "managed handoff mismatch",
  "managed handoff missing",
  "failed schema publication",
  "terminal post-core run",
  "missing post-core run",
]);

describe("Doctor preflight refusal receipts", () => {
  it("propagates the settled preflight receipts without truncating the blocked tail", async () => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-refusal-receipts-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const configRaw = '{"meta":{"lastTouchedAt":"2026-09-03T00:00:00.000Z"}}\n';
    fs.mkdirSync(path.join(stateDir, "tui"), { recursive: true });
    fs.writeFileSync(configPath, configRaw);
    fs.writeFileSync(path.join(stateDir, "tui", "last-session.json"), "not json\n");
    const entry = doctorConfigRuntimeEntrypoints.preflight;
    const preparedPreflightUrl = resolveRuntimeWorkerUrl(entry);
    const compiled = preparedPreflightUrl.pathname.endsWith(".js");
    const runtimeRoot = compiled
      ? createBuiltRuntime(root, fileURLToPath(new URL("../", preparedPreflightUrl)))
      : createSourceRuntime(root);
    const preflightUrl = resolveRuntimeWorkerUrl({
      ...entry,
      ...(compiled
        ? { root: runtimeRoot }
        : {
            currentModuleUrl: pathToFileURL(
              path.join(runtimeRoot, "src", "commands", "doctor-config-runtime.test-support.ts"),
            ).href,
          }),
    }).href;
    const { stdout } = await runIsolatedModuleScript(
      {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        NO_COLOR: "1",
      },
      `
      import { runDoctorConfigPreflight } from ${JSON.stringify(preflightUrl)};
      try {
        await runDoctorConfigPreflight({ doctorOnlyStateMigrations: true, migrateLegacyConfig: false });
        console.log("RECEIPTS:" + JSON.stringify({ completed: true }));
      } catch (error) {
        console.log("RECEIPTS:" + JSON.stringify({ name: error.name, stepReceipts: error.stepReceipts }));
      }
    `,
      { runtimeRoot, timeoutMs: 60_000 },
    );
    const result = JSON.parse(stdout.split("RECEIPTS:").at(-1) ?? "null") as {
      name: string;
      stepReceipts: import("../infra/state-migrations.types.js").LegacyStateMigrationStepReceipt[];
    };
    expect(result.name).toBe("DoctorStateMigrationRefusalError");
    const receipts = result.stepReceipts;
    const blocker = receipts.findIndex((receipt) => receipt.id === "tui-last-session");
    expect(blocker).toBeGreaterThan(0);
    expect(receipts.slice(0, blocker)).toContainEqual(
      expect.objectContaining({ id: "config-machine-state", outcome: "completed" }),
    );
    expect(receipts[blocker]).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    const tail = receipts.slice(blocker + 1);
    expect(tail.map((receipt) => receipt.id)).toEqual([
      "commitments",
      "audit-logs",
      "acp-replay-ledger",
      "managed-outgoing-images",
      "apns-registrations",
      "exec-approvals",
      "mcp-oauth",
      "restart-sentinel",
      "workspace-state",
      "web-push",
      "node-host",
      "rescue-pending",
      "skill-workshop",
      "channel-pairing",
      "plugin-doctor-state",
      "sessions",
      "acp-session-metadata",
      "agent-dir",
      "plugin-doctor-post-session-state",
    ]);
    for (const receipt of tail) {
      expect(receipt).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
        originatingRefusal: {
          stepId: "tui-last-session",
          code: "step-refused",
          message: receipts[blocker]?.refusal?.message,
        },
      });
    }
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(receipts.length);
    expect(fs.readFileSync(configPath, "utf8")).toBe(configRaw);
    const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'config.lastTouchedAt'",
          )
          .get(),
      ).toEqual({
        value_json: JSON.stringify("2026-09-03T00:00:00.000Z"),
      });
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("doctor schema-17 repair atomicity", () => {
  it("rolls back rejected v17 repair through doctor --fix", async () => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-v17-atomicity-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    const databasePath = seedV17AdditiveRepairDatabase(stateDir, {
      participantDependency: true,
    });
    const runtimeRoot = createBuiltRuntime(root);
    const result = await tempDirs.track(
      runBuiltRuntime(
        runtimeRoot,
        {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
          NO_COLOR: "1",
        },
        ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
        60_000,
      ),
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).toContain("Skipped agent database migration");
    expect(output).toContain("Participant migration cannot rebuild unknown indexes");

    const rejected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(rejected.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
      expect(
        rejected
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_test_participant_dependency'",
          )
          .get(),
      ).toEqual({ name: "idx_test_participant_dependency" });
    } finally {
      rejected.close();
    }
  });
});
