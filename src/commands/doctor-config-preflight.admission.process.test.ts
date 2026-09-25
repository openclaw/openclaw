import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { readAgentDatabasePreflightTargets } from "../state/openclaw-agent-db-registry.read.js";
import { repairAuditEventsSchema } from "../state/openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
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

function expectArchivedBytes(
  sourcePath: string,
  archiveDir: string,
  prefix: string,
  bytes: Buffer,
) {
  expect(fs.existsSync(sourcePath)).toBe(false);
  const archives = fs.readdirSync(archiveDir).filter((name) => name.startsWith(prefix));
  expect(archives).toHaveLength(1);
  expect(fs.readFileSync(path.join(archiveDir, archives[0]!))).toEqual(bytes);
}

describe("startup admission before persistent writes", () => {
  it.each([
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
      reason: "Migrated workspace setup state to SQLite",
    },
    {
      name: "legacy workspace",
      workspace: true,
      repairable: false,
      config: "local",
      reason: "Migrated workspace setup state to SQLite",
    },
    {
      name: "legacy workspace with repairable config",
      workspace: true,
      repairable: true,
      config: "local",
      reason: "Migrated workspace setup state to SQLite",
    },
    {
      name: "legacy workspace with retained plugin install records",
      workspace: true,
      repairable: false,
      retainedPluginRecords: true,
      config: "local",
      reason: "Migrated workspace setup state to SQLite",
    },
    {
      name: "session store selected by repaired agent ID",
      workspace: false,
      repairedSession: true,
      repairable: false,
      config: "local",
      reason: "__READY__",
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
      repairable: true,
      config: "local",
      consolidated: true,
      unavailablePlugin: true,
      reason: "Configured plugin load path is unavailable",
    },
    {
      name: "malformed plugin entry without an existing WAL",
      workspace: false,
      repairable: true,
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
      repairedSession,
      restored,
      retainedPluginRecords,
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
      const legacySessionPath = path.join(stateDir, "external", "agent", "sessions.json");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
      fs.mkdirSync(workspaceDir);
      if (repairedSession) {
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
        if (!repairedSession) {
          // Repair only the audit blocker; released schema 1 still needs automatic migration.
          repairAuditEventsSchema(prepared);
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
              agents: repairedSession
                ? { list: [{ id: "" }] }
                : { defaults: { workspace: workspaceDir } },
              ...(repairedSession
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
        if (repairedSession) {
          fs.mkdirSync(path.dirname(legacySessionPath), { recursive: true });
          fs.writeFileSync(
            legacySessionPath,
            JSON.stringify({
              "agent:agent:retained": {
                sessionId: "retained-session",
                sessionFile: "retained-session.jsonl",
                updatedAt: 1,
              },
            }),
          );
          fs.writeFileSync(
            path.join(path.dirname(legacySessionPath), "retained-session.jsonl"),
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
        fs.writeFileSync(
          path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
          '{"version":1,"profiles":{}}\n',
        );
        const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
        const legacyBytes =
          workspace || repairedSession
            ? fs.readFileSync(workspace ? legacyWorkspacePath : legacySessionPath)
            : undefined;
        const schemaBefore = schemaMetadata(databasePath);
        const before = manifest(stateDir);
        expect(schemaBefore.userVersion).toBe(repairedSession ? OPENCLAW_STATE_SCHEMA_VERSION : 1);
        if (!repairedSession) {
          expect(Boolean(before[path.join("state", "openclaw.sqlite-wal")])).toBe(!consolidated);
        }
        const entry =
          workspace || repairedSession
            ? `
        const { runDoctorConfigPreflight } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.preflight))});
        await runDoctorConfigPreflight({ migrateState: true, migrateLegacyConfig: false, requireStartupMigrationCheckpoint: true });
        console.log("__READY__");
      `
            : `
        const { ensureConfigReady } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.configGuard))});
        const { ExitError } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.runtime))});
        await ensureConfigReady({
          commandPath: ["gateway", "run"],
          runtime: { log: console.log, error: console.error, exit(code) { throw new ExitError(code); } },
        });
        if (${Boolean(unavailablePlugin)}) {
          const { runDoctorConfigPreflight } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.preflight))});
          const { snapshot } = await runDoctorConfigPreflight({ migrateState: false, migrateLegacyConfig: false, observe: false });
          console.log("AVAILABILITY_WARNINGS=" + JSON.stringify(snapshot.warnings));
        }
        if (${Boolean(restored)} && process.env.OPENCLAW_GATEWAY_TOKEN) {
          throw new Error("Discarded clobbered config environment leaked through admission.");
        }
      `;
        const result = await tempDirs.track(
          runSourceRuntime(
            runtimeRoot,
            {
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
            },
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
        expect(result.code, output).toBe(restored || unavailablePlugin || legacyBytes ? 0 : 78);
        expect(output).toContain(reason);
        if (legacyBytes) {
          expect(output).toContain("__READY__");
          expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
          if (workspace) {
            expectArchivedBytes(
              legacyWorkspacePath,
              workspaceDir,
              "openclaw-workspace-state.json.migrated.",
              legacyBytes,
            );
            expect(schemaMetadata(databasePath, workspaceDir).workspaceSetup).toEqual({
              version: 1,
              bootstrap_seeded_at: "2026-07-02T00:00:00.000Z",
              setup_completed_at: "2026-07-02T00:00:00.000Z",
            });
          } else {
            expectArchivedBytes(
              legacySessionPath,
              path.join(stateDir, "external", "session-sqlite-import-archive"),
              "legacy-store.sessions.json.imported-",
              legacyBytes,
            );
            const stores = inspectDatabaseCopy(databasePath, (db) =>
              readAgentDatabasePreflightTargets(db, databasePath).filter(
                (store) => store.agentId === "agent",
              ),
            );
            expect(stores.length).toBeGreaterThan(0);
            for (const store of stores) {
              const migrated = schemaMetadata(store.path);
              expect(migrated.userVersion).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
              expect(migrated.schemaMeta).toContainEqual(
                expect.objectContaining({ role: "agent", agent_id: "agent" }),
              );
            }
            const retained = stores.map((store) =>
              inspectDatabaseCopy(store.path, (db) => ({
                sessions: db
                  .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
                  .all("agent:agent:retained"),
                messages: db
                  .prepare(
                    "SELECT json_extract(event_json, '$.message.content[0].text') AS text FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
                  )
                  .all("retained-session", "retained-message"),
              })),
            );
            expect(retained.flatMap((store) => store.sessions)).toEqual([
              { current_session_id: "retained-session" },
            ]);
            expect(retained.flatMap((store) => store.messages)).toEqual([
              { text: "Retained before startup" },
            ]);
          }
        } else if (restored) {
          expect(fs.readFileSync(configPath, "utf8")).toBe(
            fs.readFileSync(`${configPath}.bak`, "utf8"),
          );
          expect(schemaMetadata(databasePath).userVersion).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        } else if (unavailablePlugin) {
          // The availability ruling (#150016/#150312) admits repair; uninspected plugin input survives.
          const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(repaired.plugins).toEqual({
            load: { paths: [path.join(root, "missing-plugin")] },
          });
          expect(repaired.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
          expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(configBefore);
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
            if (
              file !== "openclaw.json" &&
              !file.startsWith(path.join("state", "openclaw.sqlite"))
            ) {
              expect(after[file], file).toBe(hash);
            }
          }
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
