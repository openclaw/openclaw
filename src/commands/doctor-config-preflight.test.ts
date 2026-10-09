// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { createUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight as runUnobservedDoctorConfigPreflight } from "./doctor-config-preflight.js";
import {
  observeDoctorConfigStep,
  useDoctorConfigPreflightHome,
  withDoctorConfigPreflightHome as withUnscopedDoctorConfigPreflightHome,
} from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

const withScopedDoctorConfigPreflightHome = useDoctorConfigPreflightHome("preflight");

async function withDoctorConfigPreflightHome<T>(
  run: (home: string) => Promise<T>,
  bundledPlugins: readonly string[] = [],
): Promise<T> {
  return withScopedDoctorConfigPreflightHome(async (home) => {
    // Run only the real plugin contracts owned by this fixture, using prepared artifacts.
    const bundledRoot = path.join(home, "bundled");
    await fs.mkdir(bundledRoot);
    for (const pluginId of bundledPlugins) {
      await fs.cp(path.resolve("dist/extensions", pluginId), path.join(bundledRoot, pluginId), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    }
    return withEnvAsync({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot }, () => run(home));
  });
}

function runDoctorConfigPreflight(
  options: Parameters<typeof runUnobservedDoctorConfigPreflight>[0] = {},
) {
  // Admission/history and recovery include awaits outside the measured preflight stages.
  const measure = options.measure;
  return observeDoctorConfigStep("preflight-outer-unmeasured", () =>
    runUnobservedDoctorConfigPreflight({
      ...options,
      measure: measure
        ? (name, run) => observeDoctorConfigStep(name, () => measure(name, run))
        : observeDoctorConfigStep,
    }),
  );
}

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

const configOnlyOptions = { migrateState: false, migrateLegacyConfig: false } as const;
const configRepairOptions = {
  ...configOnlyOptions,
  repairPrefixedConfig: true,
  invalidConfigNote: false,
} as const;

const doctorRepairOptions = {
  migrateLegacyConfig: false,
  repairPrefixedConfig: true,
  doctorOnlyStateMigrations: true,
  preparePluginMetadataSnapshot: true,
} as const;

describe("runDoctorConfigPreflight", () => {
  it.each([
    { selector: "environment", sidecarBytes: "not JSON" },
    { selector: "prefixed-include", sidecarBytes: "retired encrypted bytes" },
  ])(
    "refuses retired OAuth sidecars before repairing config ($selector selector)",
    async ({ selector, sidecarBytes }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const oauthDir = path.join(home, "custom-credentials");
        const config = {
          agents: { entries: { main: {} } },
          plugins: { enabled: false },
          ...(selector !== "environment"
            ? { env: { vars: { OPENCLAW_OAUTH_DIR: oauthDir } } }
            : {}),
        };
        const originalConfig = `${selector.startsWith("prefixed-") ? "unexpected prefix\n" : ""}${JSON.stringify(
          selector === "prefixed-include" ? { $include: "auth-selector.json" } : config,
        )}`;
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        if (selector === "prefixed-include") {
          await fs.writeFile(
            path.join(path.dirname(configPath), "auth-selector.json"),
            JSON.stringify(config),
          );
        }
        await fs.writeFile(configPath, originalConfig);
        const backupPath = `${configPath}.bak`;
        const backupBytes = "{}\n";
        await fs.writeFile(backupPath, backupBytes);
        const authStorePath = path.join(home, ".openclaw/agents/main/agent/auth-profiles.json");
        await fs.mkdir(path.dirname(authStorePath), { recursive: true });
        await fs.writeFile(
          authStorePath,
          JSON.stringify({
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: "a".repeat(32),
                },
              },
            },
          }),
        );
        const stateFiles = (await fs.readdir(path.dirname(configPath))).toSorted();
        const legacyDir = path.join(home, ".clawdbot");
        await fs.mkdir(legacyDir);
        const sidecarDir = path.join(oauthDir, "auth-profiles");
        const sidecarPath = path.join(sidecarDir, `${"a".repeat(32)}.json`);
        await fs.mkdir(sidecarDir, { recursive: true });
        await fs.writeFile(sidecarPath, sidecarBytes);

        await withEnvAsync(
          { OPENCLAW_OAUTH_DIR: selector === "environment" ? oauthDir : undefined },
          async () => {
            for (let pass = 0; pass < 2; pass += 1) {
              await expect(runDoctorConfigPreflight(doctorRepairOptions)).rejects.toThrow(
                "Upgrade through OpenClaw 2026.9.7",
              );
              expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
              expect(await fs.readFile(backupPath, "utf8")).toBe(backupBytes);
              expect((await fs.readdir(path.dirname(configPath))).toSorted()).toEqual(stateFiles);
              expect((await fs.lstat(legacyDir)).isSymbolicLink()).toBe(false);
              expect(await fs.readFile(sidecarPath, "utf8")).toBe(sidecarBytes);
              expect(await fs.readdir(sidecarDir)).toEqual([path.basename(sidecarPath)]);
            }
          },
        );
      });
    },
  );

  it("reports stale legacy update recovery without modifying the run", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, { gateway: { mode: "local" } });
      const now = Date.now();
      const inactiveAt = now - ABANDONED_UPDATE_RUN_MS - 10;
      const clock = vi.spyOn(Date, "now").mockReturnValue(inactiveAt);
      const run = createUpdateRun({ trigger: "control-ui", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      await runDoctorConfigPreflight(configOnlyOptions);
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

  it("refuses pre-July install records restored after an earlier Doctor pass completed", async () => {
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
        const options = { repairPrefixedConfig: true, migrateLegacyConfig: false };
        expect((await runDoctorConfigPreflight(options)).snapshot.valid).toBe(true);
        const backupBefore = await fs.readFile(`${configPath}.bak`, "utf8").catch(() => undefined);
        const restored = JSON.stringify({
          ...config,
          agents: { list: [{ id: "main", name: "Operator" }] },
          meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
          plugins: { ...config.plugins, installs: { existing: legacy, imported: legacy } },
        });
        await fs.writeFile(configPath, restored);

        await expect(runDoctorConfigPreflight(options)).rejects.toThrow(/plugins\.installs/);
        expect(await fs.readFile(configPath, "utf8")).toBe(restored);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual({ existing: canonical });
        expect(await fs.readFile(`${configPath}.bak`, "utf8").catch(() => undefined)).toBe(
          backupBefore,
        );
      });
    });
  });

  it("does not recover invalid config owned by a legacy update parent", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });
      await seedLastKnownGood(home, configPath, { gateway: { mode: "local" } });
      const original = '{"gateway":{"port":"invalid"}}';
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
  });

  it("logs config warnings as structured records when stdout is non-interactive", async () => {
    await withStdoutIsTTY(false, async () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      const consoleSink = loggingState.rawConsole ?? console;
      const warnSpy = vi.spyOn(consoleSink, "warn").mockImplementation(() => undefined);

      await withDoctorConfigPreflightHome(async (home) => {
        await writeOpenClawConfig(home, {
          plugins: { deny: ["missing-doctor-warning-plugin"] },
        });

        const preflight = await runDoctorConfigPreflight({
          ...configOnlyOptions,
          invalidConfigNote: false,
        });
        expect(preflight.snapshot.valid).toBe(true);
      });

      const records = warnSpy.mock.calls
        .map(([value]) => String(value).trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          subsystem: "config",
          message: expect.stringContaining(
            "plugins.deny: plugin not found: missing-doctor-warning-plugin",
          ),
        }),
      );
      expect(noteMock).not.toHaveBeenCalledWith(expect.anything(), "Config warnings");
    });
  });

  it("renders current config warnings with their config paths", async () => {
    await withStdoutIsTTY(true, async () => {
      await withDoctorConfigPreflightHome(async (home) => {
        await writeOpenClawConfig(home, {
          plugins: { deny: ["missing-doctor-warning-plugin"] },
        });

        const preflight = await runDoctorConfigPreflight({
          ...configOnlyOptions,
          invalidConfigNote: false,
        });
        expect(preflight.snapshot.valid).toBe(true);

        const output = noteMock.mock.calls.map(([message]) => message).join("\n");
        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining(
            "- plugins.deny: plugin not found: missing-doctor-warning-plugin",
          ),
          "Config warnings",
        );
        expect(output).not.toContain("- : ");
      });
    });
  });

  it("migrates last-known-good loopback bind before restoring", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });
      await seedLastKnownGood(home, configPath, {
        gateway: { mode: "local", bind: "localhost" },
      });
      const brokenRaw = '{ "gateway": { "mode": "local" },';
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      const repaired = await runDoctorConfigPreflight(configRepairOptions);

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.bind).toBe("loopback");
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        gateway?: { bind?: string };
      };
      expect(persisted.gateway?.bind).toBe("loopback");
    });
  });

  it("migrates readable active config after preserving its state locators", async () => {
    await withDoctorConfigPreflightHome(
      async (home) => {
        const storePath = path.join(home, "custom-cron", "jobs.json");
        const configPath = await observeDoctorConfigStep("write-config", () =>
          writeOpenClawConfig(home, {
            gateway: { mode: "local", port: 19091 },
          }),
        );
        await observeDoctorConfigStep("promote-last-good", async () =>
          promoteConfigSnapshotToLastKnownGood(
            await observeDoctorConfigStep("read-before-promotion", () => readConfigFileSnapshot()),
          ),
        );
        await observeDoctorConfigStep("write-active-config", () =>
          fs.writeFile(
            configPath,
            `${JSON.stringify(
              {
                gateway: { mode: "local", port: 19092 },
                cron: { store: storePath },
                session: { idleMinutes: 45 },
                channels: {
                  discord: {
                    guilds: { "100": { channels: { general: { enabled: true } } } },
                  },
                },
              },
              null,
              2,
            )}\n`,
            "utf-8",
          ),
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
        const migratedRaw = await observeDoctorConfigStep("read-migrated-config", () =>
          fs.readFile(configPath, "utf-8"),
        );
        const entries = await observeDoctorConfigStep("list-config-directory", () =>
          fs.readdir(path.dirname(configPath)),
        );
        expect(entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."))).toEqual([]);

        const converged = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
          runDoctorConfigPreflight(configRepairOptions),
        );
        expect(converged.snapshot.valid).toBe(true);
        await expect(
          observeDoctorConfigStep("read-converged-config", () => fs.readFile(configPath, "utf-8")),
        ).resolves.toBe(migratedRaw);
      },
      ["discord"],
    );
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
            await runDoctorConfigPreflight(configRepairOptions).then(
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
        () => runDoctorConfigPreflight(configRepairOptions),
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
        runDoctorConfigPreflight(configRepairOptions),
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
  it("repairs session keys with a legacy roster through Doctor and preserves the authored backup", async () => {
    await withUnscopedDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        session: { idleMinutes: 45 },
        agents: { list: [{ id: "work" }] },
      });
      const original = await fs.readFile(configPath, "utf-8");

      const startup = await runStartupConfigPreflight({ gateway: true });
      expect(startup.snapshot.valid).toBe(false);
      expect(await fs.readFile(configPath, "utf-8")).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });

      const preflight = await runUnobservedDoctorConfigPreflight(doctorRepairOptions);

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.sourceConfig.session).toEqual({
        reset: { mode: "idle", idleMinutes: 45 },
      });
      expect((await readConfigFileSnapshot()).valid).toBe(true);
      expect(await fs.readFile(`${configPath}.bak`, "utf-8")).toBe(original);
      expect(hasActiveStartupMigrationLease()).toBe(false);
      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining("Moved session.idleMinutes"),
        "Doctor changes",
      );
    });
  });

  it("admits unchanged tilde paths across core-only and prepared plugin reads", async () => {
    await withUnscopedDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          meta: { migrations: { webhookListeners: true } },
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

  it("leaves historical transcript bytes at startup and normalizes them in later plain Doctor", async () => {
    await withUnscopedDoctorConfigPreflightHome(async (home) => {
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
  it("preserves a legacy multi-agent owner when repairing active config before recovery", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await observeDoctorConfigStep("write-config", () =>
        writeOpenClawConfig(home, {
          gateway: { mode: "local", port: 19091 },
        }),
      );
      await observeDoctorConfigStep("promote-last-good", async () =>
        promoteConfigSnapshotToLastKnownGood(
          await observeDoctorConfigStep("read-before-promotion", () => readConfigFileSnapshot()),
        ),
      );
      await observeDoctorConfigStep("write-active-config", () =>
        fs.writeFile(
          configPath,
          JSON.stringify({
            meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" },
            gateway: { mode: "local", port: 19092 },
            update: { channel: "beta" },
            agents: { list: [{ id: "ops" }, { id: "main", default: true }] },
          }),
        ),
      );

      const repaired = await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        () => runDoctorConfigPreflight(configRepairOptions),
      );

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.update?.channel).toBe("beta");
      expect(Object.keys(repaired.snapshot.config.agents?.entries ?? {}).toSorted()).toEqual([
        "main",
        "ops",
      ]);
      expect(repaired.snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("main");
      expect(repaired.snapshot.config).not.toHaveProperty("meta.lastTouchedAt");
      const persisted = JSON.parse(
        await observeDoctorConfigStep("read-persisted-config", () =>
          fs.readFile(configPath, "utf-8"),
        ),
      );
      expect(persisted.agents.ownership).toBe("explicit");
      expect(persisted.agents).not.toHaveProperty("list");
      const reread = await observeDoctorConfigStep("reread-config", () => readConfigFileSnapshot());
      expect(reread.valid).toBe(true);
      expect(reread.config.agents?.defaults?.systemAgent?.agentId).toBe("main");
      const entries = await observeDoctorConfigStep("list-config-directory", () =>
        fs.readdir(path.dirname(configPath)),
      );
      expect(entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."))).toEqual([]);
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

      const repaired = await runDoctorConfigPreflight(configRepairOptions);

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });
  it("reports persisted literal and interpolated OTel grpc as legacy config", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false, protocol: "grpc" } },
      });

      const literal = await runDoctorConfigPreflight({
        ...configOnlyOptions,
        invalidConfigNote: false,
      });
      expect(literal.snapshot.valid).toBe(false);
      expect(literal.baseConfig.diagnostics?.otel?.protocol).toBe("grpc");
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
          ...configOnlyOptions,
          invalidConfigNote: false,
        });
        expect(interpolated.snapshot.legacyIssues).toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    });
  });
});
