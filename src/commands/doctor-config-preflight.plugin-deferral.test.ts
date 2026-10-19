import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";

const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();
const noBundledPlugins = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
const updating = {
  ...noBundledPlugins,
  OPENCLAW_UPDATE_IN_PROGRESS: "1",
  OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
};
const notUpdating = {
  ...noBundledPlugins,
  OPENCLAW_UPDATE_IN_PROGRESS: undefined,
  OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
};
const binding = '{"binding":"retained"}\n';
const doctorOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  doctorOnlyStateMigrations: true,
  repairPrefixedConfig: true,
} as const;
const prepared = { preparePluginMetadataSnapshot: true } as const;
let restoreMigrationRuntime: (() => void) | undefined;

beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

function createPluginConfig(pluginId: string, config?: Record<string, string>, paths?: string[]) {
  return {
    gateway: { mode: "local" as const },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true, ...(config ? { config } : {}) } },
      ...(paths ? { load: { paths } } : {}),
    },
  };
}

function writeJson(file: string, value: unknown) {
  return fs.writeFile(file, JSON.stringify(value));
}

function objectSchema(properties: Record<string, { type: string }> = {}) {
  return { type: "object", properties, additionalProperties: false };
}

async function inspectDatabase(
  file: string,
  inspect: (database: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) => void,
) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    inspect(database);
  } finally {
    database.close();
  }
}

function withFixture(run: (fixture: ReturnType<typeof makeFixture>) => Promise<void>) {
  return withDoctorConfigPreflightHome((home) =>
    withEnvAsync(noBundledPlugins, () => run(makeFixture(home, "fixture"))),
  );
}

function makeFixture(home: string, pluginId: string) {
  const root = path.join(home, "fixture-plugin");
  const source = path.join(home, "legacy-binding.json");
  const migrated = path.join(home, "migrated-binding.json");
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  return {
    home,
    pluginId,
    root,
    source,
    migrated,
    configPath,
    databasePath: path.join(home, ".openclaw", "state", "openclaw.sqlite"),
    config: (settings?: Record<string, string>, paths?: string[]) =>
      createPluginConfig(pluginId, settings, paths),
    write: (config: Parameters<typeof writeOpenClawConfig>[1]) => writeOpenClawConfig(home, config),
    load: (config: ReturnType<typeof createPluginConfig>, paths: string[]) =>
      loadPlugins(home, config, paths),
    read: async () => JSON.parse(await fs.readFile(configPath, "utf8")),
    stateless: (contract?: Parameters<typeof installStatelessFixture>[2], channel?: boolean) =>
      installStatelessFixture(root, pluginId, contract, channel),
    install: (options: Partial<Parameters<typeof installMigrationFixture>[0]> = {}) =>
      installMigrationFixture({ root, pluginId, source, migrated, ...options }),
  };
}

function doctor(options: Parameters<typeof runDoctorConfigPreflight>[0] = {}) {
  return runDoctorConfigPreflight({ ...doctorOptions, ...options });
}

function loadPlugins(home: string, config: ReturnType<typeof createPluginConfig>, paths: string[]) {
  return writeOpenClawConfig(home, { ...config, plugins: { ...config.plugins, load: { paths } } });
}

function expectPending(pluginId: string, details: Record<string, unknown> = {}) {
  expect(readDeferredPluginMigrations()).toEqual([
    expect.objectContaining({ pluginId, ...details }),
  ]);
}

function expectDeferred(
  result: Awaited<ReturnType<typeof runDoctorConfigPreflight>>,
  pluginId: string,
) {
  expect(result.stateMigrationStepReceipts).toContainEqual(
    expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
  );
}

async function expectBinding(file: string) {
  expect(await fs.readFile(file, "utf8")).toBe(binding);
}

function expectMissing(file: string) {
  return expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function installFixture(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  setup = false,
  entry = "module.exports = {};\n",
) {
  await fs.mkdir(root, { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name,
    version: "1.0.0",
    openclaw: {
      extensions: ["./index.cjs"],
      ...(setup ? { setupEntry: "./setup-entry.cjs" } : {}),
    },
  });
  await fs.writeFile(path.join(root, "index.cjs"), entry);
  await writeJson(path.join(root, "openclaw.plugin.json"), manifest);
}

async function installMigrationFixture(params: {
  root: string;
  pluginId: string;
  source: string;
  migrated: string;
  stale?: boolean;
  phase?: "after-session-repair";
}) {
  await installFixture(params.root, "@example/deferred-fixture", {
    id: params.pluginId,
    configSchema: objectSchema(),
    doctorContract: {
      configRepair: true,
      stateMigrations: [{ id: "legacy-binding", ...(params.phase ? { phase: params.phase } : {}) }],
    },
    configContracts: { compatibilityMigrationPaths: ["legacyFixture"] },
  });
  await fs.writeFile(
    path.join(params.root, "doctor-contract-api.cjs"),
    `
    const fs = require("node:fs");
    const staleCall = () => fs.writeFileSync(${JSON.stringify(path.join(params.root, "stale-called"))}, "called");
    module.exports = {
      legacyConfigRules: [{ path: ["legacyFixture"], message: "Fixture legacy locator must migrate.",
        match: () => { ${params.stale ? 'staleCall(); throw new Error("Stale config detector executed before convergence");' : "return true;"} },
      }, {
        path: ["plugins", "entries", ${JSON.stringify(params.pluginId)}, "config", "legacyBinding"],
        message: "Fixture legacy binding must migrate.",
      }],
      normalizeCompatibilityConfig: ({ cfg }) => {
        ${
          params.stale
            ? 'throw new Error("Stale normalizer executed before convergence");'
            : `const next = structuredClone(cfg); delete next.legacyFixture;
        const pluginConfig = next.plugins?.entries?.[${JSON.stringify(params.pluginId)}]?.config;
        const legacyBinding = pluginConfig?.legacyBinding;
        if (pluginConfig) delete pluginConfig.legacyBinding;
        return { config: next, changes: cfg.legacyFixture || legacyBinding ? ["Retired fixture locator"] : [] };`
        }
      },
      stateMigrations: [{
      id: "legacy-binding", label: "Fixture legacy binding",
      ${params.phase ? `phase: ${JSON.stringify(params.phase)},` : ""}
      detectLegacyState: () => {
        ${params.stale ? 'throw new Error("Stale detector executed before convergence");' : `return fs.existsSync(${JSON.stringify(params.source)}) ? { preview: ["Import binding"] } : null;`}
      },
      migrateLegacyState: () => {
        fs.renameSync(${JSON.stringify(params.source)}, ${JSON.stringify(params.migrated)});
        return { changes: ["Imported fixture binding"], warnings: [] };
      },
    }] };
  `,
  );
}

async function installStatelessFixture(
  root: string,
  pluginId: string,
  contract: "absent" | "config-only" | "broken" | "public-setup-full-detector" = "absent",
  channel = false,
) {
  const setup = contract === "public-setup-full-detector";
  const manifest = {
    id: pluginId,
    configSchema: objectSchema({ region: { type: "string" }, legacyBinding: { type: "string" } }),
  };
  if (setup || channel) {
    Object.assign(manifest, {
      channels: [pluginId],
      channelConfigs: { [pluginId]: { schema: objectSchema({ enabled: { type: "boolean" } }) } },
    });
  }
  await installFixture(
    root,
    "@example/stateless-fixture",
    manifest,
    setup,
    setup
      ? `module.exports = { plugin: { id: ${JSON.stringify(pluginId)}, lifecycle: { detectLegacyStateMigrations: () => [] } } };\n`
      : undefined,
  );
  if (contract !== "absent" && !setup) {
    await fs.writeFile(
      path.join(root, "doctor-contract-api.cjs"),
      contract === "broken"
        ? 'throw new Error("Fixture Doctor contract unavailable");\n'
        : "module.exports = { normalizeCompatibilityConfig: ({ cfg }) => ({ config: cfg, changes: [] }) };\n",
    );
  }
  if (setup) {
    await fs.writeFile(
      path.join(root, "setup-entry.cjs"),
      `module.exports = { plugin: { id: ${JSON.stringify(pluginId)} } };\n`,
    );
  }
}

describe("configured plugin migration deferral", () => {
  it("keeps a present config-path Doctor contract available during an update rehearsal", () => {
    // The real rehearsal runs in a child; this process's shared broker outlives its fixture.
    const processTempDir = os.tmpdir();
    const tempDir = vi.spyOn(os, "tmpdir").mockReturnValue(processTempDir);
    syncBuiltinESMExports();
    onTestFinished(() => {
      tempDir.mockRestore();
      syncBuiltinESMExports();
    });
    return withFixture(async ({ home, pluginId }) => {
      const rehearsalRoot = path.join(home, ".openclaw");
      const pluginRoot = path.join(rehearsalRoot, "copied-custom-plugin");
      await installStatelessFixture(pluginRoot, pluginId, "config-only");
      await writeOpenClawConfig(home, createPluginConfig(pluginId, undefined, [pluginRoot]));

      await withEnvAsync(
        {
          ...buildUpdateRehearsalPathEnv(rehearsalRoot),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        },
        async () => {
          try {
            const result = await doctor();
            expect(result.deferredPluginMigrations).toBeUndefined();
            expect(readDeferredPluginMigrations()).toEqual([]);
          } finally {
            // The retained broker's socket lives inside the rehearsal temp root.
            await closeDefaultRetainedNativeWorkerSource();
          }
        },
      );
    });
  });

  it.each(["linked", "unrecorded"] as const)(
    "keeps a %s config-path plugin available only when package convergence skips it",
    (install) =>
      withFixture(
        async ({ home, root: pluginRoot, pluginId, source, migrated, install: installPlugin }) => {
          await fs.writeFile(source, binding);
          await installPlugin();
          const config = createPluginConfig(pluginId, undefined, [pluginRoot]);
          await writeOpenClawConfig(home, config);
          if (install === "linked") {
            await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined }, () =>
              seedInstalledPluginIndex(
                { [pluginId]: { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } },
                { config },
              ),
            );
          }

          await withEnvAsync(updating, async () => {
            await doctor();
            expect(readDeferredPluginMigrations()).toEqual(
              install === "linked"
                ? []
                : [
                    expect.objectContaining({
                      pluginId,
                      reason: expect.stringContaining("Package convergence must wait"),
                    }),
                  ],
            );
            await expectBinding(install === "linked" ? migrated : source);
            await expectMissing(install === "linked" ? source : migrated);
          });
        },
      ),
  );

  it.each([false, true])("preserves same-Doctor migration obligations (newer: %s)", (newer) =>
    withFixture(async (f) => {
      const config = f.config({ legacyBinding: f.source }, newer ? undefined : [f.root]);
      await f.write(config);
      await fs.writeFile(f.source, binding);
      if (newer) {
        await doctor();
        expectPending(f.pluginId);
        await f.stateless();
        await f.load(config, [f.root]);
      }
      let installed = false;
      const result = await doctor({
        ...(!newer ? prepared : {}),
        measure: async (name, run) => {
          const measured = await run();
          const phase = newer ? "legacy-state-migrations" : "config-snapshot";
          if (name === `doctor.config-preflight.${phase}` && !installed) {
            installed = true;
            await f.install(newer ? { phase: "after-session-repair" } : {});
            if (newer) {
              await doctor();
              expectPending(f.pluginId, { requiresStateMigration: true });
            }
          }
          return measured;
        },
      });
      expect(installed).toBe(true);
      expect(result.snapshot.valid).toBe(true);
      await expectBinding(newer ? f.source : f.migrated);
      const persisted = expect(await f.read());
      const legacyKey = `plugins.entries.${f.pluginId}.config.legacyBinding`;
      if (newer) {
        expectPending(f.pluginId, { requiresStateMigration: true });
        expectDeferred(result, f.pluginId);
        persisted.toHaveProperty(legacyKey, f.source);
        await expectMissing(f.migrated);
      } else {
        expect(result.snapshot.issues).toEqual([]);
        expect(readDeferredPluginMigrations()).toEqual([]);
        persisted.not.toHaveProperty(legacyKey);
        expect((await readConfigFileSnapshot()).valid).toBe(true);
      }
    }),
  );

  it.each([false, true])(
    "honors the allowlist for ambient channel credentials (Discord allowed: %s)",
    (allowDiscord) =>
      withFixture(async ({ home, pluginId }) => {
        const config = createPluginConfig(pluginId);
        if (allowDiscord) {
          config.plugins.allow.push("discord");
        }
        await writeOpenClawConfig(home, config);
        await withEnvAsync(
          {
            ...updating,
            DISCORD_BOT_TOKEN: "synthetic-discord-token",
          },
          async () => {
            const result = await doctor();
            expect(result.snapshot.valid).toBe(true);
            const pending = readDeferredPluginMigrations();
            expect(pending.map((entry) => entry.pluginId)).toEqual(
              allowDiscord ? ["discord", pluginId] : [pluginId],
            );
            expectDeferred(result, pluginId);
            expect(
              result.stateMigrationStepReceipts?.some(
                (receipt) =>
                  receipt.id === "plugin:discord" &&
                  receipt.outcome === "deferred" &&
                  receipt.warnings.some((warning) => warning.includes("openclaw update repair")),
              ),
            ).toBe(allowDiscord);
          },
        );
      }),
  );

  it("confirms an installed stateless plugin with a retained disabled-channel obligation", () =>
    withFixture(async ({ home, pluginId, root: pluginRoot }) => {
      const config = createPluginConfig(pluginId, { region: "us-en" });
      await writeOpenClawConfig(home, config);
      await doctor();
      expectPending(pluginId);
      await installStatelessFixture(pluginRoot, pluginId, "absent", true);
      const otherId = "configured-fixture";
      const otherRoot = path.join(home, otherId);
      await installStatelessFixture(otherRoot, otherId);
      config.plugins.allow.push(otherId);
      config.plugins.entries[otherId] = { enabled: true };
      const installedConfig = { ...config, channels: { [pluginId]: { enabled: false } } };
      installedConfig.plugins.load = { paths: [pluginRoot, otherRoot] };
      await writeOpenClawConfig(home, installedConfig);
      const result = await doctor();
      expect(result.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations()).toEqual([]);
      const checked = await readConfigFileSnapshot();
      expect(checked.warnings).toEqual([
        {
          path: `plugins.entries.${pluginId}`,
          message: "plugin disabled (channel disabled in config) but config is present",
        },
      ]);
      expect(checked.sourceConfig.plugins).toEqual(installedConfig.plugins);
      expect(checked.sourceConfig.channels).toEqual(installedConfig.channels);
    }));

  it.each(["public-setup-full-detector", "broken"] as const)(
    "inspects retained obligations through the %s contract",
    (contract) =>
      withFixture(async (f) => {
        const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
        onTestFinished(() => note.mockRestore());
        const fullEntry = contract === "public-setup-full-detector";
        const config = f.config({ region: "us-en" }, fullEntry ? [f.root] : undefined);
        await f.write(config);
        if (fullEntry) {
          await f.load(config, []);
        }
        await doctor(prepared);
        if (fullEntry) {
          expectPending(f.pluginId);
        }
        await f.stateless(contract);
        await f.load(config, [f.root]);
        const result = await doctor(prepared);
        expectPending(f.pluginId, { requiresDoctorInspection: true });
        if (fullEntry) {
          expect(result.snapshot.valid).toBe(true);
          expect(
            (await readConfigFileSnapshot()).sourceConfig.plugins?.entries?.[f.pluginId]?.config,
          ).toEqual({ region: "us-en" });
          return;
        }
        await fs.unlink(path.join(f.root, "doctor-contract-api.cjs"));
        await f.stateless();
        const original = await fs.readFile(f.configPath, "utf8");
        await doctor(prepared);
        expect(readDeferredPluginMigrations()).toEqual([]);
        expect(note).toHaveBeenCalledWith(
          '- Plugin "fixture" version "1.0.0": no plugin migration contract. No migration ran; existing data and settings have been kept.',
          "Doctor warnings",
        );
        await closeOpenClawStateDatabaseByPathAsync(f.databasePath);
        await inspectDatabase(f.databasePath, (database) => {
          const row = database
            .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
            .get(`deferred-plugin-migration:${f.pluginId}`);
          expect(row?.status).toBe("completed");
          expect(JSON.parse(String(row?.report_json))).toMatchObject({
            reason: expect.stringContaining("no plugin migration contract"),
          });
        });
        await doctor(prepared);
        expect(readDeferredPluginMigrations()).toEqual([]);
        expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
        expect((await readConfigFileSnapshot()).warnings).toEqual([]);
      }),
  );

  it.each(["doctor", "stale-candidate", "published-candidate"] as const)(
    "%s preserves pending inputs and retries after the package becomes available",
    (entry) =>
      withFixture(async (f) => {
        const { home, root: pluginRoot, configPath, source, migrated, pluginId, databasePath } = f;
        const currentPluginRoot = path.join(home, "fixture-plugin-current");
        const config = {
          ...createPluginConfig(
            pluginId,
            { legacyBinding: source },
            entry === "stale-candidate" ? [pluginRoot] : undefined,
          ),
          agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
          ...(entry === "stale-candidate" ? { legacyFixture: source } : {}),
        };
        if (entry === "stale-candidate") {
          await f.install({ stale: true });
        }
        await writeOpenClawConfig(home, config);
        await fs.writeFile(source, binding);
        if (entry === "published-candidate") {
          await fs.mkdir(path.dirname(databasePath), { recursive: true });
          await fs.writeFile(
            databasePath,
            gunzipSync(
              await fs.readFile(
                new URL(
                  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
                  import.meta.url,
                ),
              ),
            ),
          );
        }
        const original = await fs.readFile(configPath, "utf8");
        const options = entry === "published-candidate" ? { observe: false, ...prepared } : {};
        await withEnvAsync(entry.endsWith("candidate") ? updating : notUpdating, async () => {
          const pending = await doctor(options);
          expect(pending.stateMigrationStepReceipts).toContainEqual(
            expect.objectContaining({
              id: `plugin:${pluginId}`,
              outcome: "deferred",
              warnings: [expect.stringContaining("openclaw update repair")],
            }),
          );
          expectPending(pluginId, { command: "openclaw update repair" });
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          await expectBinding(source);
          if (entry === "published-candidate") {
            await closeOpenClawStateDatabaseByPathAsync(databasePath);
            expectPending(pluginId, { command: "openclaw update repair" });
            await inspectDatabase(databasePath, (database) => {
              expect(database.prepare("PRAGMA user_version").get()).toEqual({
                user_version: OPENCLAW_STATE_SCHEMA_VERSION,
              });
              expect(
                database
                  .prepare("SELECT sequence, event_id FROM audit_events WHERE event_id = ?")
                  .get("fixture-audit-event"),
              ).toEqual({ sequence: 7, event_id: "fixture-audit-event" });
            });
          }
          if (entry === "stale-candidate") {
            await expectMissing(path.join(pluginRoot, "stale-called"));
          }
        });

        if (entry === "stale-candidate") {
          await fs.rm(pluginRoot, { recursive: true });
          await loadPlugins(home, config, []);
          await withEnvAsync(
            {
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            },
            async () => {
              const retry = await doctor(options);
              expect(retry.snapshot.valid).toBe(true);
              expect(readDeferredPluginMigrations()[0]?.validationExcludedPaths).toContainEqual([
                "legacyFixture",
              ]);
              expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toHaveProperty(
                "legacyFixture",
                source,
              );
            },
          );
        }
        await f.install({ root: currentPluginRoot });
        if (entry === "doctor") {
          await writeOpenClawConfig(home, {
            ...config,
            plugins: {
              ...config.plugins,
              entries: { [pluginId]: { ...config.plugins.entries[pluginId], enabled: false } },
              load: { paths: [currentPluginRoot] },
            },
          });
          await doctor(options);
          expectPending(pluginId);
          await expectBinding(source);
        }
        await loadPlugins(home, config, [currentPluginRoot]);
        if (entry === "doctor") {
          const manifestPath = path.join(currentPluginRoot, "openclaw.plugin.json");
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          await fs.rm(path.join(currentPluginRoot, "doctor-contract-api.cjs"));
          for (const contract of ["absent", "declared-empty", "empty-module"]) {
            await writeJson(manifestPath, {
              ...manifest,
              doctorContract: contract === "absent" ? undefined : { stateMigrations: [] },
            });
            if (contract === "empty-module") {
              await fs.writeFile(
                path.join(currentPluginRoot, "doctor-contract-api.cjs"),
                "module.exports = { stateMigrations: [], normalizeCompatibilityConfig: ({cfg}) => ({config: cfg, changes: []}) };\n",
              );
            }
            const unfinished = await doctor(options);
            expectPending(pluginId);
            await expectBinding(source);
            expectDeferred(unfinished, pluginId);
          }
          const resumedPluginRoot = path.join(home, "fixture-plugin-resumed");
          await f.install({ root: resumedPluginRoot });
          await loadPlugins(home, config, [resumedPluginRoot]);
        }
        await withEnvAsync(notUpdating, async () => {
          const completed = await doctor(options);
          await expectBinding(migrated);
          expect(readDeferredPluginMigrations()).toEqual([]);
          expect(
            completed.stateMigrationStepReceipts?.filter(
              (receipt) => receipt.outcome === "deferred",
            ),
          ).toEqual([]);
        });
      }),
  );
});
