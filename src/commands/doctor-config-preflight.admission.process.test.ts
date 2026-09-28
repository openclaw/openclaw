import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { repairAuditEventsSchema } from "../state/openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runBuiltRuntime,
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
    config: "clobbered" | "local" | "absent" | "missing-mode" | "remote";
    reason: string;
    consolidated?: boolean;
    invalidPlugin?: boolean;
    unavailablePlugin?: boolean;
    selectedSession?: boolean;
    retainedPluginRecords?: boolean;
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
      name: "legacy workspace",
      workspace: true,
      repairable: false,
      config: "local",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "legacy workspace with repairable config",
      workspace: true,
      repairable: true,
      config: "local",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "legacy workspace with retained plugin install records",
      workspace: true,
      repairable: false,
      retainedPluginRecords: true,
      config: "local",
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
      name: "malformed plugin entry without an existing WAL",
      workspace: false,
      repairable: false,
      config: "local",
      consolidated: true,
      invalidPlugin: true,
      reason: "OpenClaw config is invalid",
    },
    {
      name: "missing gateway.mode",
      workspace: false,
      repairable: false,
      config: "missing-mode",
      reason: "existing config is missing gateway.mode",
    },
    {
      name: "remote gateway.mode",
      workspace: false,
      repairable: false,
      config: "remote",
      reason: "set gateway.mode=local (current: remote)",
    },
    ...["device.json", "device.json.doctor-importing", "device.json.native-importing"].map(
      (identityFile) => ({
        name: `pending identity ${identityFile}`,
        workspace: false,
        repairable: false,
        config: "local" as const,
        identityFile,
        canonicalIdentity: false,
        reason: "Legacy device identity exists",
      }),
    ),
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
      invalidPlugin,
      unavailablePlugin,
      selectedSession,
      retainedPluginRecords,
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
              gateway:
                config === "missing-mode"
                  ? {}
                  : { mode: config === "clobbered" ? "local" : config },
              plugins: unavailablePlugin
                ? { load: { paths: [path.join(root, "missing-plugin")] } }
                : invalidPlugin
                  ? { entries: { broken: { enabled: "not-a-boolean" } } }
                  : retainedPluginRecords
                    ? {
                        enabled: false,
                        installs: {
                          retained: {
                            source: "path",
                            installPath: path.join(root, "retained-plugin"),
                          },
                        },
                      }
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
        const workspaceBefore = retainedPluginRecords
          ? fs.readFileSync(legacyWorkspacePath)
          : undefined;
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
        if (retainedPluginRecords) {
          // Startup preservation is proved above; explicit Doctor now owns the repair.
          if (prepared.isOpen) {
            prepared.close();
          }
          const args = ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"];
          const doctor = await tempDirs.track(
            compiled
              ? runBuiltRuntime(runtimeRoot, env, args, 60_000)
              : runSourceRuntime(
                  runtimeRoot,
                  env,
                  [path.join(runtimeRoot, "src", "entry.ts"), ...args],
                  60_000,
                ),
          );
          const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
          expect(doctor.code, doctorOutput).toBe(0);
          expect(fs.existsSync(legacyWorkspacePath)).toBe(false);
          const archives = fs
            .readdirSync(workspaceDir)
            .filter((name) => name.startsWith("openclaw-workspace-state.json.migrated."));
          expect(archives).toHaveLength(1);
          expect(fs.readFileSync(path.join(workspaceDir, archives[0]!))).toEqual(workspaceBefore);
          expect(schemaMetadata(databasePath, workspaceDir).workspaceSetup).toEqual({
            version: 1,
            bootstrap_seeded_at: "2026-07-02T00:00:00.000Z",
            setup_completed_at: "2026-07-02T00:00:00.000Z",
          });
          expect(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins).not.toHaveProperty(
            "installs",
          );
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
