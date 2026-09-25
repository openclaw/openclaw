// Doctor repair and startup readiness preserve their independent state lifetimes.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { createConfigIO } from "../config/io.factory.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { resetLogger } from "../logging/logger.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const doctorRepairOptions = {
  migrateLegacyConfig: false,
  repairPrefixedConfig: true,
  doctorOnlyStateMigrations: true,
  preparePluginMetadataSnapshot: true,
} as const;

describe("runDoctorConfigPreflight", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetLogger();
    noteMock.mockClear();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "explicit state repair",
      options: { doctorOnlyStateMigrations: true },
      children: 1,
      error: { name: "Error" },
    },
    {
      name: "state probe",
      options: { migrateState: false },
      children: 0,
      error: { name: "Error" },
    },
    {
      name: "config-only repair",
      options: { migrateState: false, doctorOnlyStateMigrations: true },
      children: 0,
      error: { name: "Error" },
    },
  ])(
    "owns read-only child reuse and error cleanup for $name",
    async ({ options, children, error }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await writeOpenClawConfig(home, { gateway: { mode: "local" } });
        const source = path.join(home, "source.sqlite");
        const sqlite = requireNodeSqlite();
        const failure = new Error("preflight measurement failed");
        vi.mocked(spawn).mockClear();
        await expect(
          runDoctorConfigPreflight({
            ...options,
            migrateLegacyConfig: false,
            measure: async (name, run) => {
              if (name !== "doctor.config-preflight.config-snapshot") {
                return await run();
              }
              for (const version of [1, 2]) {
                const writer = new sqlite.DatabaseSync(source);
                writer.exec(`PRAGMA user_version=${version}`);
                writer.close();
                const prepared = await prepareSqliteReadOnlyLocation(source, {
                  preserveSourceArtifacts: true,
                });
                try {
                  const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
                  try {
                    expect(snapshot.prepare("PRAGMA user_version").get()).toEqual({
                      user_version: version,
                    });
                  } finally {
                    snapshot.close();
                  }
                } finally {
                  expect(await prepared.cleanupAsync()).toBe(true);
                }
              }
              throw failure;
            },
          }),
        ).rejects.toMatchObject({ ...error, message: failure.message });
        const sessions = vi
          .mocked(spawn)
          .mock.calls.flatMap((call, index) =>
            Array.isArray(call[1]) &&
            call[1].includes(SQLITE_READONLY_CHILD_ARG) &&
            call[1].includes("session")
              ? [vi.mocked(spawn).mock.results[index]!.value]
              : [],
          );
        expect(sessions).toHaveLength(children);
        for (const child of sessions) {
          expect(child.exitCode).toBe(0);
          expect(child.connected).toBe(false);
        }
      });
    },
  );

  it.each([
    { name: "session keys", extra: {} },
    {
      name: "session keys with a legacy roster",
      extra: { agents: { list: [{ id: "work" }] } },
    },
  ])("repairs $name through Doctor and preserves the authored backup", async ({ extra }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        session: { idleMinutes: 45 },
        ...extra,
      });
      const original = await fs.readFile(configPath, "utf-8");

      const startup = await runStartupConfigPreflight({ gateway: true });
      expect(startup.snapshot.valid).toBe(false);
      expect(await fs.readFile(configPath, "utf-8")).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });

      const preflight = await runDoctorConfigPreflight(doctorRepairOptions);

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.sourceConfig.session).toEqual({
        reset: { mode: "idle", idleMinutes: 45 },
      });
      expect((await readConfigFileSnapshot()).valid).toBe(true);
      expect(await fs.readFile(`${configPath}.bak`, "utf-8")).toBe(original);
      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining("Moved session.idleMinutes"),
        "Doctor changes",
      );
    });
  });

  it("admits unchanged tilde paths across core-only and prepared plugin reads", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          plugins: {
            enabled: false,
            entries: { wiki: { config: { store: { path: "~/.openclaw/wiki" } } } },
          },
        });
        const original = await fs.readFile(configPath, "utf8");
        const core = await createConfigIO({
          configPath,
          env: process.env,
          homedir: () => home,
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
        const startup = await runStartupConfigPreflight({ gateway: true });

        expect(startup.snapshot.valid).toBe(true);
        expect(startup.snapshot.sourceConfig).toEqual(core.sourceConfig);
        expect(startup.pluginMetadataSnapshot).toBeDefined();
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      });
    });
  });

  it("preserves retired state locators before committing the Doctor config repair", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const storePath = path.join(home, "custom-cron", "jobs.json");
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        cron: { store: storePath },
      });

      const preflight = await runDoctorConfigPreflight(doctorRepairOptions);

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.sourceConfig).not.toHaveProperty("cron.store");
      expect(readConfigMachineState("cron.store")).toBe(storePath);
      expect(JSON.parse(await fs.readFile(`${configPath}.bak`, "utf-8"))).toHaveProperty(
        "cron.store",
        storePath,
      );
    });
  });

  it("leaves historical transcript bytes at startup and normalizes them in later plain Doctor", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        {
          OPENCLAW_AGENT_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { mode: "local" },
            agents: { entries: { main: {} } },
            plugins: { enabled: false },
          });
          const stateDir = path.dirname(configPath);
          const scope = {
            agentId: "main",
            env: { ...process.env },
            sessionKey: "agent:main:historical-directives",
            sessionId: "historical-directives",
          };
          const historicalEvent = {
            type: "message",
            id: "historical-answer",
            parentId: null,
            timestamp: "2026-03-01T00:00:00.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "[[reply_to_current]] Historical answer" }],
            },
          };
          const originalJson = JSON.stringify(historicalEvent);
          const databasePath = resolveOpenClawAgentSqlitePath(scope);
          const readEventJson = () => {
            const { DatabaseSync } = requireNodeSqlite();
            const database = new DatabaseSync(databasePath, { readOnly: true });
            try {
              const history = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
              return executeSqliteQueryTakeFirstSync(
                database,
                history
                  .selectFrom("transcript_events")
                  .select("event_json")
                  .where("session_id", "=", scope.sessionId)
                  .where("seq", "=", 0),
              )?.event_json;
            } finally {
              clearNodeSqliteKyselyCacheForDatabase(database);
              database.close();
            }
          };
          try {
            await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
            await replaceTranscriptEvents(scope, [historicalEvent]);
            await cleanupSessionStateForTest({ stateDir });
            expect(readEventJson()).toBe(originalJson);

            await runStartupConfigPreflight({ gateway: true });

            expect(readEventJson()).toBe(originalJson);
            // Preserve the same process: readiness must not suppress plain Doctor.
            const doctor = await prepareDoctorContext(configPath, {
              options: { nonInteractive: true },
            });

            expect(doctor.prompter.shouldRepair).toBe(false);
            expect(JSON.parse(String(readEventJson()))).toEqual({
              ...historicalEvent,
              message: {
                ...historicalEvent.message,
                content: [{ type: "text", text: "Historical answer" }],
                openclawDelivery: { replyToCurrent: true },
              },
            });
          } finally {
            await cleanupSessionStateForTest({ stateDir });
          }
        },
      );
    });
  });

  it("imports an old parent's restored records after an earlier Doctor repair", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const config = {
          gateway: { mode: "local" as const },
          agents: { entries: { main: { name: "Operator" } } },
          plugins: { enabled: false },
        };
        const configPath = await writeOpenClawConfig(home, config);
        const canonical = { source: "path" as const, installPath: path.join(home, "canonical") };
        const legacy = { source: "path" as const, installPath: path.join(home, "legacy") };
        await seedInstalledPluginIndex({ existing: canonical }, { config });
        await runDoctorConfigPreflight(doctorRepairOptions);
        const restored = JSON.stringify({
          ...config,
          agents: { list: [{ id: "main", name: "Operator" }] },
          meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
          plugins: { ...config.plugins, installs: { existing: legacy, imported: legacy } },
        });
        await fs.writeFile(configPath, restored);

        const repaired = await runDoctorConfigPreflight(doctorRepairOptions);

        expect(repaired.snapshot.valid).toBe(true);
        expect(repaired.baseConfig).not.toHaveProperty("plugins.installs");
        expect(repaired.baseConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(repaired.baseConfig.agents?.entries?.main).toEqual({ name: "Operator" });
        expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual({
          existing: canonical,
          imported: legacy,
        });
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(restored);
        const saved = await fs.readFile(configPath, "utf8");
        expect((await runDoctorConfigPreflight(doctorRepairOptions)).snapshot.valid).toBe(true);
        expect(await fs.readFile(configPath, "utf8")).toBe(saved);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(restored);
      });
    });
  });

  it.each([
    {
      name: "updater-deferred validation",
      config: { meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" } },
      updating: "1",
    },
    {
      name: "remaining validation errors",
      config: { session: { idleMinutes: 45 }, gateway: { port: "invalid" } },
      updating: undefined,
    },
  ])("leaves invalid config unchanged during startup for $name", async ({ config, updating }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, config);
      const original = await fs.readFile(configPath, "utf-8");
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: updating }, async () => {
        const startup = await runStartupConfigPreflight({ gateway: true });
        expect(startup.snapshot.valid).toBe(false);
      });
      expect(await fs.readFile(configPath, "utf-8")).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(hasActiveStartupMigrationLease()).toBe(false);
    });
  });
});
