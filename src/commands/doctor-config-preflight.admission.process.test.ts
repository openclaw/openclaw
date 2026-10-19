import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";
import { repairAuditEventsSchema } from "../state/openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());

function manifest(root: string): Record<string, string> {
  // Ignore lifecycle scratch and SQLite reader noise; persisted state stays byte-identical.
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter((relative) => relative.split(path.sep)[0] !== "tmp" && !relative.endsWith("-shm"))
      .toSorted()
      .map((relative) => [
        relative,
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, relative)))
          .digest("hex"),
      ]),
  );
}

function schemaMetadata(databasePath: string) {
  // Inspect a private copy: opening a consolidated WAL database can itself create a WAL.
  const root = tempDirs.createTempDir("openclaw-admission-schema-");
  const copy = path.join(root, "database.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(`${databasePath}${suffix}`)) {
      fs.copyFileSync(`${databasePath}${suffix}`, `${copy}${suffix}`);
    }
  }
  const db = new DatabaseSync(copy);
  try {
    return {
      userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
      schemaMeta: db.prepare("SELECT * FROM schema_meta ORDER BY rowid").all(),
    };
  } finally {
    db.close();
  }
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixtureEnv(root: string, stateDir: string, configPath: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NO_COLOR: "1",
  };
}

function runFixture(runtimeRoot: string, env: NodeJS.ProcessEnv, script: string) {
  return tempDirs.track(
    runSourceRuntime(runtimeRoot, env, ["--input-type=module", "--eval", script], 60_000),
  );
}

type AdmissionCase = {
  workspace?: boolean;
  repairable?: boolean;
  config?: "clobbered" | "local" | "absent";
  consolidated?: boolean;
  unavailablePlugin?: boolean;
  selectedSession?: boolean;
  restored?: boolean;
  redirected?: boolean;
  identityFile?: string;
  canonicalIdentity?: boolean;
};
it.each<[string, AdmissionCase]>([
  ["Config auto-restored from backup", { config: "clobbered", restored: true }],
  ["Config auto-restored from backup", { config: "clobbered", restored: true, redirected: true }],
  ["Legacy workspace setup state requires migration", { config: "clobbered", workspace: true }],
  ["Legacy session store requires migration", { selectedSession: true }],
  ["Missing config", { config: "absent" }],
  ["Missing config", { config: "absent", consolidated: true }],
  ["Configured plugin load path is unavailable", { consolidated: true, unavailablePlugin: true }],
  ["OpenClaw config is invalid", { consolidated: true, unavailablePlugin: true, repairable: true }],
  ["Legacy device identity exists", { identityFile: "device.json" }],
  ["__CANONICAL_IDENTITY_READY__", { identityFile: "device.json", canonicalIdentity: true }],
])(
  "startup admission preserves shipped state: %s (%j)",
  async (
    reason,
    {
      workspace = false,
      repairable = false,
      config = "local",
      consolidated,
      unavailablePlugin,
      selectedSession,
      restored,
      redirected,
      identityFile,
      canonicalIdentity,
    },
  ) => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-startup-admission-"));
    const preparedPreflightUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.preflight);
    const compiled = preparedPreflightUrl.pathname.endsWith(".js");
    const runtimeRoot = compiled
      ? createBuiltRuntime(root, fileURLToPath(new URL("../", preparedPreflightUrl)))
      : createSourceRuntime(root);
    // Keep package discovery fixture-local in both source and prepared subprocesses.
    const runtimeLocation = compiled
      ? { root: runtimeRoot }
      : {
          currentModuleUrl: pathToFileURL(
            path.join(runtimeRoot, "src/commands/doctor-config-runtime.test-support.ts"),
          ).href,
        };
    const runtimeUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
      resolveRuntimeWorkerUrl({ ...entry, ...runtimeLocation }).href;
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(
      stateDir,
      config === "clobbered" ? "recovered-workspace" : "workspace",
    );
    const configPath = path.join(stateDir, "openclaw.json");
    const baseEnv = fixtureEnv(root, stateDir, configPath);
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    fs.mkdirSync(workspaceDir);
    if (selectedSession) {
      // Reach the legacy session refusal without an earlier registry-schema refusal.
      openOpenClawStateDatabase({ path: databasePath, env: baseEnv });
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    } else {
      fs.writeFileSync(
        databasePath,
        gunzipSync(fs.readFileSync("test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz")),
      );
    }
    // Keeping this idle connection open retains a real WAL in the manifest.
    const prepared = new DatabaseSync(databasePath);
    try {
      prepared.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      if (!selectedSession) {
        repairAuditEventsSchema(prepared);
      }
      const identity = canonicalIdentity ? generateStoredDeviceIdentity() : undefined;
      if (identity) {
        const { deviceId, publicKeyPem, privateKeyPem, createdAtMs } = identity;
        prepared
          .prepare(
            "INSERT INTO device_identities (identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms) VALUES ('primary', ?, ?, ?, ?, ?)",
          )
          .run(deviceId, publicKeyPem, privateKeyPem, createdAtMs, createdAtMs);
      }
      if (consolidated) {
        prepared.close();
      }
      if (config !== "absent") {
        writeJson(configPath, {
          gateway: { mode: "local" },
          plugins: unavailablePlugin
            ? { load: { paths: [path.join(root, "missing-plugin")] } }
            : { enabled: false },
          agents: selectedSession
            ? { entries: { agent: { workspace: workspaceDir } } }
            : { defaults: { workspace: workspaceDir } },
          session: selectedSession
            ? { store: path.join(stateDir, "external/{agentId}/sessions.json") }
            : repairable
              ? { idleMinutes: 45 }
              : undefined,
        });
        if (config === "clobbered") {
          fs.copyFileSync(configPath, `${configPath}.bak`);
          fs.writeFileSync(
            configPath,
            '{"update":{"channel":"stable"},"env":{"vars":{"OPENCLAW_GATEWAY_TOKEN":"discarded-test-token"}}}\n',
          );
        }
      }
      if (selectedSession) {
        const legacyStore = path.join(stateDir, "external", "agent", "sessions.json");
        fs.mkdirSync(path.dirname(legacyStore), { recursive: true });
        writeJson(legacyStore, {
          "agent:agent:retained": {
            sessionId: "retained-session",
            sessionFile: "retained-session.jsonl",
            updatedAt: 1,
          },
        });
        fs.writeFileSync(
          path.join(path.dirname(legacyStore), "retained-session.jsonl"),
          '{"type":"session","version":3,"id":"retained-session"}\n' +
            '{"type":"message","id":"retained-message","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"Retained before startup"}]}}\n',
        );
      }
      if (workspace) {
        writeJson(path.join(workspaceDir, "openclaw-workspace-state.json"), {
          version: 1,
          bootstrapSeededAt: "2026-07-02T00:00:00.000Z",
          setupCompletedAt: "2026-07-02T00:00:00.000Z",
        });
      }
      const identityPath = identityFile ? path.join(stateDir, "identity", identityFile) : null;
      const legacyIdentityRaw = '{"retiredIdentity":"leave for Doctor"}\n';
      if (identityPath) {
        fs.mkdirSync(path.dirname(identityPath), { recursive: true });
        fs.writeFileSync(identityPath, legacyIdentityRaw);
      }
      fs.writeFileSync(
        path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
        '{"version":1,"profiles":{}}\n',
      );
      const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
      const schemaBefore = schemaMetadata(databasePath);
      const before = manifest(stateDir);
      expect(schemaBefore.userVersion).toBe(selectedSession ? OPENCLAW_STATE_SCHEMA_VERSION : 1);
      if (!selectedSession) {
        expect(Boolean(before[path.join("state", "openclaw.sqlite-wal")])).toBe(!consolidated);
      }
      const entry = `
        const { ensureConfigReady } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.configGuard))});
        const { ExitError } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.runtime))});
        await ensureConfigReady({
          commandPath: ["gateway", "run"],
          runtime: { log: console.log, error: console.error, exit(code) { throw new ExitError(code); } },
        });
        if (${Boolean(unavailablePlugin)}) {
          const { runStartupConfigPreflight } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.startup))});
          const { snapshot } = await runStartupConfigPreflight({ gateway: false, observe: false });
          console.log("AVAILABILITY_WARNINGS=" + JSON.stringify(snapshot.warnings));
        }
        if (${Boolean(restored)} && process.env.OPENCLAW_GATEWAY_TOKEN) {
          throw new Error("Discarded clobbered config environment leaked through admission.");
        }
        if (${Boolean(redirected)} &&
            (process.env.PGCLI_ADMISSION_BOOTSTRAP !== "retained" ||
             process.env.PGCLI_ADMISSION_DOTENV !== "retained")) {
          throw new Error("Config recovery discarded accepted routing or dotenv environment.");
        }
        if (${Boolean(canonicalIdentity)}) {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
          try {
            const current = db.prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'").get();
            if (current?.device_id !== ${JSON.stringify(identity?.deviceId)}) {
              throw new Error("Startup replaced the canonical identity.");
            }
          } finally { db.close(); }
          console.log("__CANONICAL_IDENTITY_READY__");
        }
      `;
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        PATH: process.env.PATH,
        OPENCLAW_WORKSPACE_DIR:
          config === "clobbered" ? path.join(stateDir, "empty-workspace") : workspaceDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      };
      if (redirected) {
        fs.mkdirSync(path.join(root, ".openclaw"));
        writeJson(path.join(root, ".openclaw", "openclaw.json"), {
          env: {
            vars: {
              OPENCLAW_STATE_DIR: stateDir,
              PGCLI_ADMISSION_BOOTSTRAP: "retained",
            },
          },
        });
        fs.writeFileSync(path.join(stateDir, ".env"), "PGCLI_ADMISSION_DOTENV=retained\n");
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
      }
      const result = await runFixture(
        runtimeRoot,
        env,
        `
        try {
          ${entry}
        } catch (error) {
          console.error(error.message);
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        }
      `,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const admitted = restored || canonicalIdentity || (unavailablePlugin && !repairable);
      expect(result.code, output).toBe(admitted ? 0 : 78);
      expect(output).toContain(reason);
      if (admitted) {
        expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      }
      if (identityPath) {
        expect(fs.readFileSync(identityPath, "utf8")).toBe(legacyIdentityRaw);
      }
      if (restored) {
        expect(fs.readFileSync(configPath, "utf8")).toBe(
          fs.readFileSync(`${configPath}.bak`, "utf8"),
        );
      } else if (unavailablePlugin && !repairable) {
        // An unavailable package is advisory; startup preserves its current config and inputs.
        expect(fs.readFileSync(configPath, "utf8")).toBe(configBefore);
        expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
        const warningLine = output
          .split("\n")
          .find((line) => line.startsWith("AVAILABILITY_WARNINGS="));
        assert(warningLine, "Admission must expose its typed availability warning");
        const warnings = JSON.parse(warningLine.slice("AVAILABILITY_WARNINGS=".length));
        expect(warnings).toContainEqual(
          expect.objectContaining({
            code: "configured-plugin-path-unavailable",
            path: "plugins.load.paths",
            source: path.join(root, "missing-plugin"),
          }),
        );
        const after = manifest(stateDir);
        for (const [file, hash] of Object.entries(before)) {
          if (!file.startsWith(path.join("state", "openclaw.sqlite"))) {
            expect(after[file], file).toBe(hash);
          }
        }
      } else if (!canonicalIdentity) {
        expect(manifest(stateDir)).toEqual(before);
        expect(schemaMetadata(databasePath)).toEqual(schemaBefore);
      }
    } finally {
      if (prepared.isOpen) {
        prepared.close();
      }
    }
  },
  75_000,
);
async function seedMalformedDatabase(
  stateDir: string,
  mutation: string,
  shared = false,
): Promise<string> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  // Exercise the migration refusal with known shared history, rather than a lost journal.
  const statePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  await closeOpenClawStateDatabaseAsync();
  const databasePath = shared
    ? statePath
    : path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    if (!shared) {
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        env,
        path: databasePath,
        register: false,
      });
    }
    database.exec(mutation);
  } finally {
    database.close();
  }
  // The offline mutation must not inherit the creator's clean-close admission.
  revokeSqliteDatabaseAdmissionsForPath(databasePath);
  return databasePath;
}

it.each<[string, string, boolean, string?]>([
  ["no agent owner", "UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'", false],
  [
    "column definitions differ for worktrees",
    "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
    true,
  ],
  ["Deferred legacy agent/session migration: select an agent owner", "", false],
  [
    "ownership metadata is invalid",
    "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES ('gateway.supervision', '\"invalid\"', 1)",
    true,
    "openclaw database ownership claim",
  ],
])(
  "preserves unused legacy state but refuses an unsafe required store: %s",
  async (reason, mutation, shared, recovery = "openclaw doctor --fix") => {
    const database = mutation !== "";
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-legacy-owner-refusal-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const config = {
      meta: { migrations: { webhookListeners: true } },
      gateway: { mode: "local", auth: { mode: "none" } },
      agents: {
        ownership: "explicit",
        ...(database ? { defaults: { systemAgent: { agentId: "main" } } } : {}),
        entries: { main: {}, blocker: {}, digest: {} },
      },
    } satisfies OpenClawConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...fixtureEnv(root, stateDir, configPath),
      OPENCLAW_TEST_FAST: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(path.join(stateDir, "agent"), { recursive: true });
    writeJson(configPath, config);
    const legacyPath = database
      ? await seedMalformedDatabase(stateDir, mutation, shared)
      : path.join(stateDir, "agent", "settings.json");
    const approvalsPath = path.join(stateDir, "exec-approvals.json");
    const approvalsJson = JSON.stringify({ version: 1, defaults: {}, agents: {} });
    if (!database) {
      fs.writeFileSync(legacyPath, '{"legacy":true}\n');
      fs.writeFileSync(approvalsPath, approvalsJson);
    }
    const before = fs.readFileSync(legacyPath);
    const configBefore = fs.readFileSync(configPath);
    const preflightUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.startup).href;
    const script = `
        const { runStartupConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
        try {
          await runStartupConfigPreflight({
            gateway: true,
          });
          console.log("__READY__");
        } catch (error) {
          console.error("__REFUSED__", error instanceof Error ? error.stack : String(error));
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        }
      `;
    const result = await runFixture(createSourceRuntime(root), env, script);
    const output = `${result.stderr}\n${result.stdout}`;

    expect(result, output).toMatchObject({ code: database ? 78 : 0, signal: null });
    if (database) {
      expect(result.stdout, output).not.toContain("__READY__");
      expect(result.stderr, output).toContain("__REFUSED__");
      expect(output).toContain(recovery);
      expect(output).toContain(reason);
    } else {
      expect(result.stdout, output).toContain("__READY__");
      expect(output).not.toContain("__REFUSED__");
      expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsJson);
      expect(fs.readdirSync(stateDir)).not.toContainEqual(
        expect.stringMatching(/^exec-approvals\.json\.migrated\./),
      );
    }
    expect(fs.readFileSync(legacyPath)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  },
  75_000,
);
