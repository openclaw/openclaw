import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
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
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight as unobservedPreflight } from "./doctor-config-preflight.js";
import {
  observeDoctorConfigStep as step,
  useDoctorConfigPreflightHome,
  withDoctorConfigPreflightHome as withUnscopedHome,
} from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

const withScopedHome = useDoctorConfigPreflightHome("preflight");

async function withHome<T>(
  run: (home: string) => Promise<T>,
  bundledPlugins: readonly string[] = [],
): Promise<T> {
  return withScopedHome(async (home) => {
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

function preflight(options: Parameters<typeof unobservedPreflight>[0] = {}) {
  // Admission/history and recovery include awaits outside the measured preflight stages.
  const measure = options.measure;
  return step("preflight-outer-unmeasured", () =>
    unobservedPreflight({
      ...options,
      measure: measure ? (name, run) => step(name, () => measure(name, run)) : step,
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

const repairDuringUpdate = () => duringUpdate(() => preflight(configRepairOptions));
const duringUpdate = <T>(run: () => Promise<T>) =>
  withEnvAsync(
    { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" },
    run,
  );
const readText = (file: string) => fs.readFile(file, "utf8");
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readText(file));
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const localGateway = { gateway: { mode: "local" as const } };
const warning = "plugins.deny: plugin not found: missing-doctor-warning-plugin";
function captureJsonWarnings() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
  return vi.spyOn(loggingState.rawConsole ?? console, "warn").mockImplementation(() => {});
}

async function clobberedFiles(configPath: string) {
  return (await fs.readdir(path.dirname(configPath))).filter((entry) =>
    entry.startsWith("openclaw.json.clobbered."),
  );
}

async function writeLastGood(home: string) {
  const configPath = await step("write-config", () =>
    writeOpenClawConfig(home, { gateway: { mode: "local", port: 19091 } }),
  );
  await step("promote-last-good", async () =>
    promoteConfigSnapshotToLastKnownGood(
      await step("read-before-promotion", () => readConfigFileSnapshot()),
    ),
  );
  return configPath;
}

describe("runDoctorConfigPreflight", () => {
  it.each([
    { selector: "environment", sidecarBytes: "not JSON" },
    { selector: "prefixed-include", sidecarBytes: "retired encrypted bytes" },
  ])(
    "refuses retired OAuth sidecars before repairing config ($selector selector)",
    ({ selector, sidecarBytes }) =>
      withHome(async (home) => {
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
        const id = "a".repeat(32);
        const provider = "openai-codex";
        const authStorePath = path.join(home, ".openclaw/agents/main/agent/auth-profiles.json");
        await fs.mkdir(path.dirname(authStorePath), { recursive: true });
        await writeJson(authStorePath, {
          profiles: {
            [`${provider}:default`]: {
              type: "oauth",
              provider,
              oauthRef: { source: "openclaw-credentials", provider, id },
            },
          },
        });
        const stateFiles = (await fs.readdir(path.dirname(configPath))).toSorted();
        const legacyDir = path.join(home, ".clawdbot");
        await fs.mkdir(legacyDir);
        const sidecarDir = path.join(oauthDir, "auth-profiles");
        const sidecarPath = path.join(sidecarDir, `${id}.json`);
        await fs.mkdir(sidecarDir, { recursive: true });
        await fs.writeFile(sidecarPath, sidecarBytes);

        await withEnvAsync(
          { OPENCLAW_OAUTH_DIR: selector === "environment" ? oauthDir : undefined },
          async () => {
            for (let pass = 0; pass < 2; pass += 1) {
              await expect(preflight(doctorRepairOptions)).rejects.toThrow(
                "Upgrade through OpenClaw 2026.9.7",
              );
              expect(await readText(configPath)).toBe(originalConfig);
              expect(await readText(backupPath)).toBe(backupBytes);
              expect((await fs.readdir(path.dirname(configPath))).toSorted()).toEqual(stateFiles);
              expect((await fs.lstat(legacyDir)).isSymbolicLink()).toBe(false);
              expect(await readText(sidecarPath)).toBe(sidecarBytes);
              expect(await fs.readdir(sidecarDir)).toEqual([path.basename(sidecarPath)]);
            }
          },
        );
      }),
  );

  it("reports stale legacy update recovery without modifying the run", () =>
    withHome(async (home) => {
      await writeOpenClawConfig(home, localGateway);
      const now = Date.now();
      const inactiveAt = now - ABANDONED_UPDATE_RUN_MS - 10;
      const clock = vi.spyOn(Date, "now").mockReturnValue(inactiveAt);
      const run = createUpdateRun({ trigger: "control-ui", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      await preflight(configOnlyOptions);
      expect(noteMock).toHaveBeenCalledWith(
        `Update ${run.runId}: no activity since ${new Date(inactiveAt).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``,
        "Update history",
      );
      expect(getUpdateRun(run.runId)).toEqual(run);
    }));

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetLogger();
    noteMock.mockClear();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "repairs empty install metadata with a pending retired plugin: %s",
    (pending) =>
      withHome(async (home) => {
        const config = {
          gateway: { mode: "local" as const },
          plugins: { enabled: false, entries: { wecom: { config: { retained: true } } } },
        };
        const configPath = await writeOpenClawConfig(home, {
          ...config,
          plugins: { ...config.plugins, installs: {} },
        });
        const original = await readText(configPath);
        const canonical = { source: "path" as const, installPath: path.join(home, "canonical") };
        await seedInstalledPluginIndex({ existing: canonical }, { config });
        if (pending) {
          await recordDeferredPluginMigrations({
            pending: [
              {
                pluginId: "wecom",
                reason: "The migration owner is unavailable.",
                command: "openclaw doctor --fix",
                configPaths: [["plugins", "entries", "wecom", "config"]],
              },
            ],
          });
        }
        const migrations = readDeferredPluginMigrations();

        expect((await preflight(configRepairOptions)).snapshot.valid).toBe(true);
        expect(await readText(`${configPath}.bak`)).toBe(original);
        expect(await readJson(configPath)).toEqual(
          expect.objectContaining({ plugins: config.plugins }),
        );
        expect(await readPersistedInstalledPluginIndexInstallRecordsAsync()).toEqual({
          existing: canonical,
        });
        expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
        expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
        expect(await readJson(configPath)).toEqual(
          expect.objectContaining({ plugins: config.plugins }),
        );
        expect(readDeferredPluginMigrations()).toEqual(migrations);
      }),
  );

  it("refuses pre-July install records restored after an earlier Doctor pass completed", () =>
    withHome(async (home) => {
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
        expect((await preflight(options)).snapshot.valid).toBe(true);
        const backupBefore = await readText(`${configPath}.bak`).catch(() => undefined);
        const restored = JSON.stringify({
          ...config,
          agents: { list: [{ id: "main", name: "Operator" }] },
          meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
          plugins: { ...config.plugins, installs: { existing: legacy, imported: legacy } },
        });
        await fs.writeFile(configPath, restored);

        await expect(preflight(options)).rejects.toThrow(/plugins\.installs/);
        expect(await readText(configPath)).toBe(restored);
        expect(await readPersistedInstalledPluginIndexInstallRecordsAsync()).toEqual({
          existing: canonical,
        });
        expect(await readText(`${configPath}.bak`).catch(() => undefined)).toBe(backupBefore);
      });
    }));

  it("does not recover invalid config owned by a legacy update parent", () =>
    withHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, localGateway);
      await seedLastKnownGood(home, configPath, localGateway);
      const original = '{"gateway":{"port":"invalid"}}';
      await fs.writeFile(configPath, original);
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "off",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        },
        () => preflight({ ...configOnlyOptions, repairPrefixedConfig: true }),
      );
      expect(await readText(configPath)).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(path.dirname(configPath))).some((name) => name.includes("clobbered")),
      ).toBe(false);
    }));

  it.each([false, true])("renders config warnings for interactive stdout: %s", (isTTY) =>
    withStdoutIsTTY(isTTY, () =>
      withHome(async (home) => {
        const warnSpy = isTTY ? undefined : captureJsonWarnings();
        await writeOpenClawConfig(home, {
          plugins: { deny: ["missing-doctor-warning-plugin"] },
        });
        const result = await preflight({
          ...configOnlyOptions,
          invalidConfigNote: false,
        });
        expect(result.snapshot.valid).toBe(true);
        if (isTTY) {
          expect(noteMock).toHaveBeenCalledWith(
            expect.stringContaining(`- ${warning}`),
            "Config warnings",
          );
          expect(noteMock.mock.calls.map(([message]) => message).join("\n")).not.toContain("- : ");
        } else {
          const records = warnSpy!.mock.calls
            .map(([value]) => String(value).trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          expect(records).toContainEqual(
            expect.objectContaining({
              level: "warn",
              subsystem: "config",
              message: expect.stringContaining(warning),
            }),
          );
          expect(noteMock).not.toHaveBeenCalledWith(expect.anything(), "Config warnings");
        }
      }),
    ),
  );

  it("migrates last-known-good loopback bind before restoring", () =>
    withHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, localGateway);
      await seedLastKnownGood(home, configPath, {
        gateway: { mode: "local", bind: "localhost" },
      });
      await fs.writeFile(configPath, '{ "gateway": { "mode": "local" },');

      const repaired = await preflight(configRepairOptions);

      expect(repaired.snapshot).toMatchObject({
        valid: true,
        config: { gateway: { bind: "loopback" } },
      });
      expect(await readJson(configPath)).toMatchObject({ gateway: { bind: "loopback" } });
    }));

  it("migrates readable active config after preserving its state locators", () =>
    withHome(
      async (home) => {
        const storePath = path.join(home, "custom-cron", "jobs.json");
        const configPath = await writeLastGood(home);
        await step("write-active-config", () =>
          writeJson(configPath, {
            gateway: { mode: "local", port: 19092 },
            cron: { store: storePath },
            session: { idleMinutes: 45 },
            channels: {
              discord: { guilds: { "100": { channels: { general: { enabled: true } } } } },
            },
          }),
        );

        const repaired = await duringUpdate(() =>
          preflight({ ...configRepairOptions, migrateState: true }),
        );

        expect(repaired.snapshot).toMatchObject({
          valid: true,
          config: {
            gateway: { port: 19092 },
            session: { reset: { idleMinutes: 45 } },
            channels: {
              discord: { guilds: { "100": { channels: { general: { enabled: true } } } } },
            },
          },
        });
        expect(readConfigMachineState("cron.store")).toBe(storePath);
        const migratedRaw = await step("read-migrated-config", () => readText(configPath));
        expect(await clobberedFiles(configPath)).toEqual([]);

        const converged = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
          preflight(configRepairOptions),
        );
        expect(converged.snapshot.valid).toBe(true);
        await expect(step("read-converged-config", () => readText(configPath))).resolves.toBe(
          migratedRaw,
        );
      },
      ["discord"],
    ));

  it("leaves unparseable config untouched and provides recovery steps", () =>
    withHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const brokenRaw = '{ "gateway": { "mode": "local" }, "models": {';
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      await withEnvAsync({ OPENCLAW_CONTAINER_HINT: "repair-test" }, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const failure = await preflight(configRepairOptions).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          for (const text of [
            configPath,
            "is not parseable and cannot be repaired automatically",
            "openclaw --container repair-test config validate",
            "hand-edit the file",
            "move it aside",
            "openclaw --container repair-test onboard",
          ]) {
            expect((failure as Error).message).toContain(text);
          }
        }
      });

      await expect(readText(configPath)).resolves.toBe(brokenRaw);
      expect(await clobberedFiles(configPath)).toHaveLength(0);
    }));

  it("restores last-known-good for malformed plugin policy values", () =>
    withHome(async (home) => {
      const configPath = await writeLastGood(home);
      const lastGoodRaw = await readText(configPath);
      await writeJson(configPath, {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: "bad" },
      });

      const repaired = await repairDuringUpdate();

      expect(repaired.snapshot).toMatchObject({
        valid: true,
        config: { gateway: { port: 19091 } },
      });
      await expect(readText(configPath)).resolves.toBe(lastGoodRaw);
      const clobbered = await clobberedFiles(configPath);
      expect(clobbered).toHaveLength(1);
      await expect(readText(path.join(path.dirname(configPath), clobbered[0]!))).resolves.toContain(
        '"port": 19092',
      );

      const converged = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
        preflight(configRepairOptions),
      );
      expect(converged.snapshot.valid).toBe(true);
      await expect(readText(configPath)).resolves.toBe(lastGoodRaw);
      expect(await clobberedFiles(configPath)).toEqual(clobbered);
    }));
  it("repairs session keys with a legacy roster through Doctor and preserves the authored backup", () =>
    withUnscopedHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        session: { idleMinutes: 45 },
        agents: { list: [{ id: "work" }] },
      });
      const original = await readText(configPath);

      const startup = await runStartupConfigPreflight({ gateway: true });
      expect(startup.snapshot.valid).toBe(false);
      expect(await readText(configPath)).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await unobservedPreflight(doctorRepairOptions);

      expect(result.snapshot.valid).toBe(true);
      expect(result.snapshot.sourceConfig.session).toEqual({
        reset: { mode: "idle", idleMinutes: 45 },
      });
      expect((await readConfigFileSnapshot()).valid).toBe(true);
      expect(await readText(`${configPath}.bak`)).toBe(original);
      expect(hasActiveStartupMigrationLease()).toBe(false);
      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining("Moved session.idleMinutes"),
        "Doctor changes",
      );
    }));

  it("admits unchanged tilde paths across core-only and prepared plugin reads", () =>
    withUnscopedHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          meta: { migrations: { webhookListeners: true } },
          gateway: { mode: "local" },
          plugins: {
            enabled: false,
            entries: { wiki: { config: { store: { path: "~/.openclaw/wiki" } } } },
          },
        });
        const original = await readText(configPath);
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
        expect(await readText(configPath)).toBe(original);
      });
    }));

  it("leaves historical transcript bytes at startup and normalizes them in later plain Doctor", () =>
    withUnscopedHome(async (home) => {
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
            storePath: resolveSessionStorePathCore(undefined, {
              agentId: "main",
              env: process.env,
            }),
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
            await using doctor = await prepareDoctorContext(configPath, {
              options: { nonInteractive: true },
            });

            expect(doctor.prompter.shouldRepair).toBe(false);
            expect(JSON.parse(String(readEventJson()))).toEqual({
              ...historicalEvent,
              message: {
                ...historicalEvent.message,
                content: [{ type: "text", text: "Historical answer" }],
                display: true,
                openclawDelivery: { replyToCurrent: true },
              },
            });
          } finally {
            await cleanupSessionStateForTest({ stateDir });
          }
        },
      );
    }));
  it("preserves a legacy multi-agent owner when repairing active config before recovery", () =>
    withHome(async (home) => {
      const configPath = await writeLastGood(home);
      await step("write-active-config", () =>
        writeJson(configPath, {
          meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" },
          gateway: { mode: "local", port: 19092 },
          update: { channel: "beta" },
          agents: { list: [{ id: "ops" }, { id: "main", default: true }] },
        }),
      );

      const repaired = await repairDuringUpdate();

      expect(repaired.snapshot).toMatchObject({
        valid: true,
        config: {
          gateway: { port: 19092 },
          update: { channel: "beta" },
          agents: { defaults: { systemAgent: { agentId: "main" } } },
        },
      });
      expect(Object.keys(repaired.snapshot.config.agents?.entries ?? {}).toSorted()).toEqual([
        "main",
        "ops",
      ]);
      expect(repaired.snapshot.config).not.toHaveProperty("meta.lastTouchedAt");
      const persisted = await step("read-persisted-config", () => readJson(configPath));
      expect(persisted).toHaveProperty("agents.ownership", "explicit");
      expect(persisted).not.toHaveProperty("agents.list");
      const reread = await step("reread-config", () => readConfigFileSnapshot());
      expect(reread).toMatchObject({
        valid: true,
        config: { agents: { defaults: { systemAgent: { agentId: "main" } } } },
      });
      expect(await clobberedFiles(configPath)).toEqual([]);
    }));

  it("does not restore last-known-good for stale plugins.deny entries", () =>
    withHome(async (home) => {
      const configPath = await writeLastGood(home);
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await writeJson(configPath, currentConfig);

      const repaired = await preflight(configRepairOptions);

      expect(repaired.snapshot).toMatchObject({ valid: true, config: currentConfig });
      await expect(readText(configPath)).resolves.toContain('"missing-deny"');
    }));
  it("reports persisted literal and interpolated OTel grpc as legacy config", () =>
    withHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false, protocol: "grpc" } },
      });

      const literal = await preflight({
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
        const interpolated = await preflight({
          ...configOnlyOptions,
          invalidConfigNote: false,
        });
        expect(interpolated.snapshot.legacyIssues).toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    }));
});
