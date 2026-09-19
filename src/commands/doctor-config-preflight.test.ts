// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCliProfileEnv } from "../cli/profile.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import {
  hasActiveStartupMigrationLease,
  readMigrationCheckpointStatus,
} from "../infra/startup-migration-checkpoint.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { resolveMigrationCheckpointIdentity } from "./doctor-config-preflight-checkpoint.js";
import { shouldSkipPluginValidationForDoctorConfigPreflight } from "./doctor-config-preflight-plugin-index.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { startupCheckpointOptions } from "./doctor-config-preflight.state-migration.test-helpers.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { isStartupConfigRepairResult } from "./doctor/shared/automatic-startup-config-repair.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Checkpoint provenance comes from dist/build-info.json, which unit-test environments
// (CI shards, unbuilt checkouts) legitimately lack; without it the checkpoint layer
// deliberately fails open and never records. Pin a deterministic build identity while
// keeping the real record/read/lease logic so checkpoint assertions stay meaningful.
vi.mock("../infra/startup-migration-checkpoint.js", async (importActual) => {
  const actual = await importActual<typeof import("../infra/startup-migration-checkpoint.js")>();
  const pin = <P extends { buildIdentity?: string | null }, R>(fn: (params?: P) => R) =>
    ((params?: P) => fn({ buildIdentity: "test-build", ...params } as P)) as typeof fn;
  return {
    ...actual,
    readMigrationCheckpointStatus: pin(actual.readMigrationCheckpointStatus),
    recordSuccessfulStartupMigrations: pin(actual.recordSuccessfulStartupMigrations),
    recordSuccessfulStateMigrations: pin(actual.recordSuccessfulStateMigrations),
  };
});

async function withStdoutIsTTY<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process.stdout, "isTTY", original);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function readConfigHealthRow(env: NodeJS.ProcessEnv, configPath: string) {
  const { db } = openOpenClawStateDatabase({ env });
  const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    healthDb
      .selectFrom("config_health_entries")
      .select("config_path")
      .where("config_path", "=", configPath),
  );
}

async function writeLegacyConfig(home: string): Promise<string> {
  const legacyPath = path.join(home, ".clawdbot", "clawdbot.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, '{"gateway":{"mode":"local"}}\n', "utf-8");
  return legacyPath;
}

async function seedLastKnownGood(
  home: string,
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  const lastGoodPath = `${configPath}.last-good`;
  await fs.writeFile(lastGoodPath, raw, "utf-8");
  const fingerprint = createConfigHealthFingerprint({
    raw,
    parsed: config,
    stat: await fs.stat(lastGoodPath),
  });
  patchConfigHealthEntryToStore(
    {
      env: { ...process.env, HOME: home },
      homedir: () => home,
      logger: { warn: () => {} },
    },
    configPath,
    { lastKnownGood: fingerprint, lastPromotedGood: fingerprint },
  );
}

describe("runDoctorConfigPreflight", () => {
  it.each([
    {
      name: "startup admission",
      options: { requireStartupMigrationCheckpoint: true },
      children: 1,
      error: { name: "ExitError", code: 78 },
    },
    {
      name: "explicit state repair",
      options: { doctorOnlyStateMigrations: true },
      children: 1,
      error: { name: "Error" },
    },
    {
      name: "state probe",
      options: { requireStateMigrationCheckpoint: true },
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
            skipPristineStartupStateMigrations: true,
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

  it("reports an activation timeout without reopening its finished history", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, { gateway: { mode: "local" } });
      const run = createUpdateRun({ trigger: "cli" });
      const finished = finishUpdateRun(run.runId, {
        status: "failed",
        reason: "update-activation-timeout",
      });

      await runDoctorConfigPreflight({ migrateState: false, migrateLegacyConfig: false });

      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining("update-activation-timeout"),
        "Update history",
      );
      const output = noteMock.mock.calls.flat().join("\n");
      expect(output).toContain("openclaw update status");
      expect(output).toContain("Wait for the owning updater and its child processes to stop");
      expect(output).toContain("openclaw update repair");
      expect(getUpdateRun(run.runId)).toEqual(finished);
    });
  });

  it("surfaces recorded cleanup warnings from a successful update", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, { gateway: { mode: "local" } });
      const run = createUpdateRun({ trigger: "cli" });
      const detail =
        "Warning: Skipped derived cache cleanup: permission denied. Run openclaw doctor --fix.";
      recordUpdateRunStep(run.runId, {
        step: "warning:openclaw doctor",
        status: "completed",
        detail,
      });
      finishUpdateRun(run.runId, { status: "succeeded" });
      await runDoctorConfigPreflight({ migrateState: false, migrateLegacyConfig: false });
      expect(noteMock).toHaveBeenCalledWith(expect.stringContaining(detail), "Update history");
      expect(getUpdateRun(run.runId)?.status).toBe("succeeded");
    });
  });
  it("reports stale legacy update recovery without modifying the run", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, { gateway: { mode: "local" } });
      const now = Date.now();
      const inactiveAt = now - ABANDONED_UPDATE_RUN_MS - 10;
      const clock = vi.spyOn(Date, "now").mockReturnValue(inactiveAt);
      const run = createUpdateRun({ trigger: "control-ui", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      await runDoctorConfigPreflight({ migrateState: false, migrateLegacyConfig: false });
      expect(noteMock).toHaveBeenCalledWith(
        `Update ${run.runId}: no activity since ${new Date(inactiveAt).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``,
        "Update history",
      );
      expect(getUpdateRun(run.runId)).toEqual(run);
    });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetLogger();
    noteMock.mockClear();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "session keys", extra: {} },
    {
      name: "session keys with a legacy roster",
      extra: { agents: { list: [{ id: "work" }] } },
    },
  ])(
    "migrates $name under startup preflight and checkpoints the valid reread",
    async ({ extra }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          session: { idleMinutes: 45 },
          ...extra,
        });
        const original = await fs.readFile(configPath, "utf-8");
        const before = await readConfigFileSnapshot();

        const preflight = await runDoctorConfigPreflight({
          ...startupCheckpointOptions,
          skipPristineStartupStateMigrations: true,
          beforeStateMigrations: async (snapshot) => {
            if (!snapshot) {
              return true;
            }
            if (snapshot.valid) {
              expect(hasActiveStartupMigrationLease()).toBe(true);
            }
            return !snapshot.valid || isStartupConfigRepairResult(before, snapshot);
          },
        });

        expect(preflight.snapshot.valid).toBe(true);
        expect(preflight.snapshot.sourceConfig.session).toEqual({
          reset: { mode: "idle", idleMinutes: 45 },
        });
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        expect(isStartupConfigRepairResult(before, preflight.snapshot)).toBe(true);
        expect(await fs.readFile(`${configPath}.bak`, "utf-8")).toBe(original);
        expect(
          readMigrationCheckpointStatus({
            identity: resolveMigrationCheckpointIdentity({
              snapshot: preflight.snapshot,
              baseConfig: preflight.baseConfig,
              pluginMigrationFingerprint:
                preflight.pluginMetadataSnapshot?.configFingerprint ?? null,
            }),
          }),
        ).toBe("startup-current");
        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining("Moved session.idleMinutes"),
          "Doctor changes",
        );
      });
    },
  );

  it("preserves retired state locators before committing the startup config migration", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const storePath = path.join(home, "custom-cron", "jobs.json");
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        cron: { store: storePath },
      });

      const preflight = await runDoctorConfigPreflight(startupCheckpointOptions);

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.sourceConfig).not.toHaveProperty("cron.store");
      expect(readConfigMachineState("cron.store")).toBe(storePath);
      expect(JSON.parse(await fs.readFile(`${configPath}.bak`, "utf-8"))).toHaveProperty(
        "cron.store",
        storePath,
      );
    });
  });

  it("imports an old parent's restored records after the same build already checkpointed", async () => {
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
        const options = { ...startupCheckpointOptions, skipPristineStartupStateMigrations: true };
        const checkpointStatus = (
          preflight: Awaited<ReturnType<typeof runDoctorConfigPreflight>>,
        ) =>
          readMigrationCheckpointStatus({
            identity: resolveMigrationCheckpointIdentity({
              snapshot: preflight.snapshot,
              baseConfig: preflight.baseConfig,
              pluginMigrationFingerprint:
                preflight.pluginMetadataSnapshot?.configFingerprint ?? null,
            }),
          });
        expect(checkpointStatus(await runDoctorConfigPreflight(options))).toBe("startup-current");
        const restored = JSON.stringify({
          ...config,
          agents: { list: [{ id: "main", name: "Operator" }] },
          meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
          plugins: { ...config.plugins, installs: { existing: legacy, imported: legacy } },
        });
        await fs.writeFile(configPath, restored);

        const repaired = await runDoctorConfigPreflight(options);

        expect(repaired.snapshot.valid).toBe(true);
        expect(repaired.baseConfig).not.toHaveProperty("plugins.installs");
        expect(repaired.baseConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(repaired.baseConfig.agents?.entries?.main).toEqual({ name: "Operator" });
        expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual({
          existing: canonical,
          imported: legacy,
        });
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(restored);
        expect(checkpointStatus(repaired)).toBe("startup-current");
        const saved = await fs.readFile(configPath, "utf8");
        expect(checkpointStatus(await runDoctorConfigPreflight(options))).toBe("startup-current");
        expect(await fs.readFile(configPath, "utf8")).toBe(saved);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(restored);
      });
    });
  });

  it.each(["prefix", "invalid"] as const)(
    "does not recover %s config owned by a legacy update parent",
    async (kind) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });
        await seedLastKnownGood(home, configPath, { gateway: { mode: "local" } });
        const original =
          kind === "prefix"
            ? 'diagnostic prefix\n{"gateway":{"mode":"local"}}'
            : '{"gateway":{"port":"invalid"}}';
        await fs.writeFile(configPath, original);
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "off",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
          },
          async () => {
            await runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              repairPrefixedConfig: true,
            });
          },
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await fs.readdir(path.dirname(configPath))).some((name) => name.includes("clobbered")),
        ).toBe(false);
      });
    },
  );

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
  ])("leaves config unchanged with the doctor hint for $name", async ({ config, updating }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, config);
      const original = await fs.readFile(configPath, "utf-8");
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: updating }, async () => {
        await expect(
          runDoctorConfigPreflight({
            ...startupCheckpointOptions,
            skipPristineStartupStateMigrations: true,
          }),
        ).rejects.toThrow("openclaw doctor --fix");
      });
      expect(await fs.readFile(configPath, "utf-8")).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(hasActiveStartupMigrationLease()).toBe(false);
    });
  });

  it("logs config warnings as structured records when stdout is non-interactive", async () => {
    await withStdoutIsTTY(false, async () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      const consoleSink = loggingState.rawConsole ?? console;
      const warnSpy = vi.spyOn(consoleSink, "warn").mockImplementation(() => undefined);

      await withDoctorConfigPreflightHome(async (home) => {
        await writeOpenClawConfig(home, {
          models: { providers: { openai: { contextTokens: 64_000 } } },
        });

        await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
      });

      const records = warnSpy.mock.calls
        .map(([value]) => String(value).trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          subsystem: "config",
          message: expect.stringContaining("models.providers.openai.contextTokens"),
        }),
      );
      expect(noteMock).not.toHaveBeenCalledWith(expect.anything(), "Config warnings");
    });
  });

  it("renders legacy context-budget notices with their config paths", async () => {
    await withStdoutIsTTY(true, async () => {
      await withDoctorConfigPreflightHome(async (home) => {
        await writeOpenClawConfig(home, {
          models: { providers: { openai: { contextTokens: 64_000 } } },
        });

        await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });

        const output = noteMock.mock.calls.map(([message]) => message).join("\n");
        expect(output).toContain("- models.providers.openai.contextTokens:");
        expect(output).not.toContain("- : ");
      });
    });
  });

  it("supports non-observing config reads", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });

      await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
      });

      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toBeUndefined();
    });
  });

  it("migrates legacy config into the active state directory", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeLegacyConfig(home);
      const stateDir = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-state-")));
      const configPath = path.join(stateDir, "openclaw.json");
      const defaultConfigPath = path.join(home, ".openclaw", "openclaw.json");

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_STATE_DIR: stateDir,
          },
          async () => {
            const preflight = await runDoctorConfigPreflight({
              migrateState: false,
              invalidConfigNote: false,
            });

            expect(preflight.snapshot.path).toBe(configPath);
            await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
            await expect(fs.access(defaultConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
          },
        );
      } finally {
        await cleanupSessionStateForTest({ stateDir });
      }
    });
  });

  it("migrates legacy config into an explicit config path", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeLegacyConfig(home);
      const configRoot = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-config-")));
      const configPath = path.join(configRoot, "nested", "custom-openclaw.json");

      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
        },
      );
    });
  });

  it("migrates legacy config into the selected profile", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeLegacyConfig(home);
      const profileStateDir = path.join(home, ".openclaw-work");
      const configPath = path.join(profileStateDir, "openclaw.json");

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_STATE_DIR: undefined,
          },
          async () => {
            applyCliProfileEnv({ profile: "work", homedir: () => home });
            const preflight = await runDoctorConfigPreflight({
              migrateState: false,
              invalidConfigNote: false,
            });

            expect(preflight.snapshot.path).toBe(configPath);
            await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
          },
        );
      } finally {
        await cleanupSessionStateForTest({ stateDir: profileStateDir });
      }
    });
  });

  it("skips plugin schema validation while doctor is running inside update", () => {
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("collects legacy config issues outside the normal config read path", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
        },
      });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(false);
      expect(preflight.snapshot.legacyIssues.map((issue) => issue.path)).toContain("memorySearch");
      const memorySearch = (
        preflight.baseConfig as {
          memorySearch?: { provider?: unknown; fallback?: unknown };
        }
      ).memorySearch;
      expect(memorySearch?.provider).toBe("local");
      expect(memorySearch?.fallback).toBe("none");
    });
  });

  it("reports persisted literal and interpolated OTel grpc as legacy config", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false, protocol: "grpc" } },
      });

      const literal = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(literal.snapshot.legacyIssues).toContainEqual(
        expect.objectContaining({ path: "diagnostics.otel.protocol" }),
      );

      const configPath = literal.snapshot.path;
      await fs.writeFile(
        configPath,
        '{ diagnostics: { otel: { enabled: false, protocol: "${OTEL_PROTOCOL}" } } }\n',
        "utf-8",
      );
      await withEnvAsync({ OTEL_PROTOCOL: "grpc" }, async () => {
        const interpolated = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
        expect(interpolated.snapshot.legacyIssues).toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    });
  });

  it("does not treat the process-only OTel protocol fallback as persisted config", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false } },
      });

      await withEnvAsync({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, async () => {
        const preflight = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
        expect(preflight.snapshot.legacyIssues).not.toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    });
  });

  it("restores invalid config from last-known-good only during repair preflight", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(configPath, "{ invalid json", "utf-8");

      const inspectOnly = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(inspectOnly.snapshot.valid).toBe(false);

      const repaired = await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        () =>
          runDoctorConfigPreflight({
            migrateState: false,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
          }),
      );

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.mode).toBe("local");
      expect(await fs.readFile(configPath, "utf-8")).toBe(lastGoodRaw);
    });
  });

  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)(
    "migrates last-known-good gateway bind %s to %s before restoring",
    async (legacyBind, canonicalBind) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
        });
        await seedLastKnownGood(home, configPath, {
          gateway: { mode: "local", bind: legacyBind },
        });
        const brokenRaw = '{ "gateway": { "mode": "local" },';
        await fs.writeFile(configPath, brokenRaw, "utf-8");

        const repaired = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        });

        expect(repaired.snapshot.valid).toBe(true);
        expect(repaired.snapshot.config.gateway?.bind).toBe(canonicalBind);
        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          gateway?: { bind?: string };
        };
        expect(persisted.gateway?.bind).toBe(canonicalBind);
      });
    },
  );

  it("preserves a legacy multi-agent owner when repairing active config before recovery", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      await fs.writeFile(
        configPath,
        JSON.stringify({
          meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" },
          gateway: { mode: "local", port: 19092 },
          update: { channel: "beta" },
          agents: { list: [{ id: "ops" }, { id: "main", default: true }] },
        }),
      );

      const before = await readConfigFileSnapshot();
      const repaired = await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        () =>
          runDoctorConfigPreflight({
            migrateState: false,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
          }),
      );

      expect(repaired.snapshot.valid).toBe(true);
      expect(isStartupConfigRepairResult(before, repaired.snapshot)).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.update?.channel).toBe("beta");
      expect(Object.keys(repaired.snapshot.config.agents?.entries ?? {}).toSorted()).toEqual([
        "main",
        "ops",
      ]);
      expect(repaired.snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("main");
      expect(repaired.snapshot.config).not.toHaveProperty("meta.lastTouchedAt");
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(persisted.agents.ownership).toBe("explicit");
      expect(persisted.agents).not.toHaveProperty("list");
      const reread = await readConfigFileSnapshot();
      expect(reread.valid).toBe(true);
      expect(reread.config.agents?.defaults?.systemAgent?.agentId).toBe("main");
      const entries = await fs.readdir(path.dirname(configPath));
      expect(entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."))).toEqual([]);
    });
  });

  it("migrates readable active config after preserving its state locators", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const storePath = path.join(home, "custom-cron", "jobs.json");
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local", port: 19092 },
            cron: { store: storePath },
            session: { idleMinutes: 45 },
            channels: {
              discord: {
                guilds: { "100": { channels: { general: { allow: true } } } },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const repaired = await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        () =>
          runDoctorConfigPreflight({
            migrateState: true,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
          }),
      );

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config).toHaveProperty("session.reset.idleMinutes", 45);
      expect(repaired.snapshot.config).toHaveProperty(
        "channels.discord.guilds.100.channels.general.enabled",
        true,
      );
      expect(readConfigMachineState("cron.store")).toBe(storePath);
      const migratedRaw = await fs.readFile(configPath, "utf-8");
      const entries = await fs.readdir(path.dirname(configPath));
      expect(entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."))).toEqual([]);

      const converged = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
        runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        }),
      );
      expect(converged.snapshot.valid).toBe(true);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(migratedRaw);
    });
  });

  it("preserves the active config when last-known-good cannot converge", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });
      await seedLastKnownGood(home, configPath, {
        gateway: { mode: "local", bind: "not-a-bind-mode" },
      });
      const brokenRaw = '{ "gateway": { "mode": "local" },';
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      const failure = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("cannot be repaired automatically");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
    });
  });

  it("leaves unparseable config untouched and provides recovery steps", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const brokenRaw = '{ "gateway": { "mode": "local" }, "models": {';
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      await withEnvAsync({ OPENCLAW_CONTAINER_HINT: "repair-test" }, async () => {
        const failures: unknown[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          failures.push(
            await runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              repairPrefixedConfig: true,
              invalidConfigNote: false,
            }).then(
              () => null,
              (error: unknown) => error,
            ),
          );
        }

        for (const failure of failures) {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toContain(configPath);
          expect((failure as Error).message).toContain(
            "is not parseable and cannot be repaired automatically",
          );
          expect((failure as Error).message).toContain(
            "openclaw --container repair-test config validate",
          );
          expect((failure as Error).message).toContain("hand-edit the file");
          expect((failure as Error).message).toContain("move it aside");
          expect((failure as Error).message).toContain("openclaw --container repair-test onboard");
        }
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."));
      expect(clobbered).toHaveLength(0);
    });
  });

  it("does not restore last-known-good for stale plugins.deny entries", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf-8");

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });

  it("restores last-known-good for malformed plugin policy values", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19092 }, plugins: { deny: "bad" } }, null, 2)}\n`,
        "utf-8",
      );

      const repaired = await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        () =>
          runDoctorConfigPreflight({
            migrateState: false,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
          }),
      );

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19091);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."));
      expect(clobbered).toHaveLength(1);
      await expect(
        fs.readFile(path.join(path.dirname(configPath), clobbered[0]!), "utf-8"),
      ).resolves.toContain('"port": 19092');

      const converged = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
        runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        }),
      );
      expect(converged.snapshot.valid).toBe(true);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
      expect(
        (await fs.readdir(path.dirname(configPath))).filter((entry) =>
          entry.startsWith("openclaw.json.clobbered."),
        ),
      ).toEqual(clobbered);
    });
  });
});
