import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";
import { repairAuditEventsSchema } from "../state/openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
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
  // Coordinator locks under tmp/ are lifecycle scratch, not persisted operator state.
  // SQLite WAL readers update the shared-memory reader index (*-shm).
  // Accept that reader noise; main databases, WALs, and all other files stay byte-identical.
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

function inspectDatabaseCopy<T>(databasePath: string, read: (database: DatabaseSync) => T): T {
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
    return read(db);
  } finally {
    db.close();
  }
}

function schemaMetadata(databasePath: string, workspacePath?: string) {
  return inspectDatabaseCopy(databasePath, (db) => ({
    userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
    schemaMeta: db.prepare("SELECT * FROM schema_meta ORDER BY rowid").all(),
    workspaceSetup: workspacePath
      ? db
          .prepare(
            "SELECT version, bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_path = ?",
          )
          .get(workspacePath)
      : undefined,
  }));
}

describe("startup admission before persistent writes", () => {
  it.each<{
    name: string;
    workspace: boolean;
    repairable: boolean;
    config: "clobbered" | "local" | "absent";
    reason: string;
    consolidated?: boolean;
    unavailablePlugin?: boolean;
    selectedSession?: boolean;
    restored?: boolean;
    identityFile?: string;
    canonicalIdentity?: boolean;
  }>([
    {
      name: "clobbered config with a healthy backup",
      workspace: false,
      repairable: false,
      config: "clobbered",
      restored: true,
      reason: "Config auto-restored from backup",
    },
    {
      name: "clobbered config with a legacy workspace in its backup",
      workspace: true,
      repairable: false,
      config: "clobbered",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "session store selected by canonical agent ID",
      workspace: false,
      selectedSession: true,
      repairable: false,
      config: "local",
      reason: "Legacy session store requires migration",
    },
    {
      name: "missing config",
      workspace: false,
      repairable: false,
      config: "absent",
      reason: "Missing config",
    },
    {
      name: "missing config without an existing WAL",
      workspace: false,
      repairable: false,
      config: "absent",
      consolidated: true,
      reason: "Missing config",
    },
    {
      name: "unavailable plugin without an existing WAL",
      workspace: false,
      repairable: false,
      config: "local",
      consolidated: true,
      unavailablePlugin: true,
      reason: "Configured plugin load path is unavailable",
    },
    {
      name: "unavailable plugin with legacy-invalid config",
      workspace: false,
      repairable: true,
      config: "local",
      consolidated: true,
      unavailablePlugin: true,
      reason: "OpenClaw config is invalid",
    },
    {
      name: "pending identity device.json",
      workspace: false,
      repairable: false,
      config: "local",
      identityFile: "device.json",
      canonicalIdentity: false,
      reason: "Legacy device identity exists",
    },
    {
      name: "canonical identity with stale retired source",
      workspace: false,
      repairable: false,
      config: "local",
      identityFile: "device.json",
      canonicalIdentity: true,
      reason: "__CANONICAL_IDENTITY_READY__",
    },
  ])(
    "admits or preserves shipped state for $name",
    async ({
      workspace,
      repairable,
      config,
      reason,
      consolidated,
      unavailablePlugin,
      selectedSession,
      restored,
      identityFile,
      canonicalIdentity,
    }) => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-startup-admission-"));
      const preparedPreflightUrl = resolveRuntimeWorkerUrl(
        doctorConfigRuntimeEntrypoints.preflight,
      );
      const compiled = preparedPreflightUrl.pathname.endsWith(".js");
      const runtimeRoot = compiled
        ? createBuiltRuntime(root, fileURLToPath(new URL("../", preparedPreflightUrl)))
        : createSourceRuntime(root);
      // Keep package discovery fixture-local in both source and prepared subprocesses.
      const runtimeUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
        resolveRuntimeWorkerUrl({
          ...entry,
          ...(compiled
            ? { root: runtimeRoot }
            : {
                currentModuleUrl: pathToFileURL(
                  path.join(
                    runtimeRoot,
                    "src",
                    "commands",
                    "doctor-config-runtime.test-support.ts",
                  ),
                ).href,
              }),
        }).href;
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(
        stateDir,
        config === "clobbered" ? "recovered-workspace" : "workspace",
      );
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const legacyWorkspacePath = path.join(workspaceDir, "openclaw-workspace-state.json");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
      fs.mkdirSync(workspaceDir);
      if (selectedSession) {
        // Reach the legacy session refusal without an earlier registry-schema refusal.
        openOpenClawStateDatabase({
          path: databasePath,
          env: {
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
          },
        });
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
          prepared
            .prepare(
              "INSERT INTO device_identities (identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms) VALUES ('primary', ?, ?, ?, ?, ?)",
            )
            .run(
              identity.deviceId,
              identity.publicKeyPem,
              identity.privateKeyPem,
              identity.createdAtMs,
              identity.createdAtMs,
            );
        }
        if (consolidated) {
          prepared.close();
        }
        if (config !== "absent") {
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              gateway: { mode: "local" },
              plugins: unavailablePlugin
                ? { load: { paths: [path.join(root, "missing-plugin")] } }
                : { enabled: false },
              agents: selectedSession
                ? { entries: { agent: { workspace: workspaceDir } } }
                : { defaults: { workspace: workspaceDir } },
              ...(selectedSession
                ? {
                    session: {
                      store: path.join(stateDir, "external", "{agentId}", "sessions.json"),
                    },
                  }
                : repairable
                  ? { session: { idleMinutes: 45 } }
                  : {}),
            }),
          );
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
          fs.writeFileSync(
            legacyStore,
            JSON.stringify({
              "agent:agent:retained": {
                sessionId: "retained-session",
                sessionFile: "retained-session.jsonl",
                updatedAt: 1,
              },
            }),
          );
          fs.writeFileSync(
            path.join(path.dirname(legacyStore), "retained-session.jsonl"),
            [
              { type: "session", version: 3, id: "retained-session" },
              {
                type: "message",
                id: "retained-message",
                parentId: null,
                message: {
                  role: "user",
                  content: [{ type: "text", text: "Retained before startup" }],
                },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
        }
        if (workspace) {
          fs.writeFileSync(
            legacyWorkspacePath,
            JSON.stringify({
              version: 1,
              bootstrapSeededAt: "2026-07-02T00:00:00.000Z",
              setupCompletedAt: "2026-07-02T00:00:00.000Z",
            }),
          );
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
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_WORKSPACE_DIR:
            config === "clobbered" ? path.join(stateDir, "empty-workspace") : workspaceDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          NO_COLOR: "1",
        };
        const result = await tempDirs.track(
          runSourceRuntime(
            runtimeRoot,
            env,
            [
              "--input-type=module",
              "--eval",
              `
        try {
          ${entry}
        } catch (error) {
          console.error(error.message);
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        }
      `,
            ],
            60_000,
          ),
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.code, output).toBe(
          restored || canonicalIdentity || (unavailablePlugin && !repairable) ? 0 : 78,
        );
        expect(output).toContain(reason);
        if (identityPath) {
          expect(fs.readFileSync(identityPath, "utf8")).toBe(legacyIdentityRaw);
        }
        if (restored) {
          expect(fs.readFileSync(configPath, "utf8")).toBe(
            fs.readFileSync(`${configPath}.bak`, "utf8"),
          );
          expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        } else if (unavailablePlugin && !repairable) {
          // An unavailable package is advisory; startup preserves its current config and inputs.
          expect(fs.readFileSync(configPath, "utf8")).toBe(configBefore);
          expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
          expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
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
        } else if (canonicalIdentity) {
          expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        } else {
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
});

const STARTUP_RECOVERY = "openclaw doctor --fix";
const legacyFixtures = createFixtureLifetime();
afterAll(() => legacyFixtures.cleanup());

function seedMalformedDatabase(stateDir: string, mutation: string, shared = false): string {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  // Exercise the migration refusal with known shared history, rather than a lost journal.
  const statePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
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
  return databasePath;
}

describe("startup legacy store classification", () => {
  it.each([
    {
      database: true,
      reason: "no agent owner",
      mutation: "UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'",
      shared: false,
    },
    {
      database: true,
      reason: "column definitions differ for worktrees",
      mutation:
        "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
      shared: true,
    },
    {
      database: false,
      reason: "Deferred legacy agent/session migration: select an agent owner",
      mutation: "",
      shared: false,
    },
    {
      database: true,
      reason: "ownership metadata is invalid",
      mutation:
        "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES ('gateway.supervision', '\"invalid\"', 1)",
      shared: true,
      recovery: "openclaw database ownership claim",
    },
  ])(
    "preserves unused legacy state but refuses an unsafe required store ($reason, shared=$shared)",
    async ({ database, reason, mutation, shared, recovery = STARTUP_RECOVERY }) => {
      const root = fs.realpathSync(legacyFixtures.createTempDir("openclaw-legacy-owner-refusal-"));
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
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
        NO_COLOR: "1",
      };
      delete env.NODE_ENV;
      delete env.OPENCLAW_HOME;
      delete env.VITEST;

      fs.mkdirSync(path.join(stateDir, "agent"), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config));
      const legacyPath = database
        ? seedMalformedDatabase(stateDir, mutation, shared)
        : path.join(stateDir, "agent", "settings.json");
      if (!database) {
        fs.writeFileSync(legacyPath, '{"legacy":true}\n');
        fs.writeFileSync(
          path.join(stateDir, "exec-approvals.json"),
          JSON.stringify({ version: 1, defaults: {}, agents: {} }),
        );
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
      const result = await legacyFixtures.track(
        runSourceRuntime(
          createSourceRuntime(root),
          env,
          ["--input-type=module", "--eval", script],
          60_000,
        ),
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.code, output).toBe(database ? 78 : 0);
      expect(result.signal, output).toBeNull();
      if (database) {
        expect(result.stdout, output).not.toContain("__READY__");
        expect(result.stderr, output).toContain("__REFUSED__");
        expect(output).toContain(recovery);
        expect(output).toContain(reason);
      } else {
        expect(result.stdout, output).toContain("__READY__");
        expect(output).not.toContain("__REFUSED__");
        expect(fs.readFileSync(path.join(stateDir, "exec-approvals.json"), "utf8")).toBe(
          JSON.stringify({ version: 1, defaults: {}, agents: {} }),
        );
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
});
