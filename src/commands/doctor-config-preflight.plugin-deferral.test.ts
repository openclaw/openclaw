import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";

const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();
const doctorOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  doctorOnlyStateMigrations: true,
  repairPrefixedConfig: true,
} as const;
let restoreMigrationRuntime: (() => void) | undefined;

beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

function createPluginConfig(pluginId: string, config?: Record<string, string>, paths?: string[]) {
  return {
    gateway: { mode: "local" },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true, ...(config ? { config } : {}) } },
      ...(paths ? { load: { paths } } : {}),
    },
  };
}

async function installMigrationFixture(params: {
  root: string;
  pluginId: string;
  source: string;
  migrated: string;
  stale?: boolean;
  phase?: "after-session-repair";
}) {
  await fs.mkdir(params.root, { recursive: true });
  await fs.writeFile(
    path.join(params.root, "package.json"),
    JSON.stringify({
      name: "@example/deferred-fixture",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(path.join(params.root, "index.cjs"), "module.exports = {};\n");
  await fs.writeFile(
    path.join(params.root, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      doctorContract: {
        configRepair: true,
        stateMigrations: [
          { id: "legacy-binding", ...(params.phase ? { phase: params.phase } : {}) },
        ],
      },
      configContracts: { compatibilityMigrationPaths: ["legacyFixture"] },
    }),
  );
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
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@example/stateless-fixture",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        ...(setup ? { setupEntry: "./setup-entry.cjs" } : {}),
      },
    }),
  );
  await fs.writeFile(
    path.join(root, "index.cjs"),
    contract === "public-setup-full-detector"
      ? `module.exports = { plugin: { id: ${JSON.stringify(pluginId)}, lifecycle: { detectLegacyStateMigrations: () => [] } } };\n`
      : "module.exports = {};\n",
  );
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      ...(setup || channel
        ? {
            channels: [pluginId],
            channelConfigs: {
              [pluginId]: {
                schema: {
                  type: "object",
                  properties: { enabled: { type: "boolean" } },
                  additionalProperties: false,
                },
              },
            },
          }
        : {}),
      configSchema: {
        type: "object",
        properties: { region: { type: "string" }, legacyBinding: { type: "string" } },
        additionalProperties: false,
      },
    }),
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
  it("keeps a present config-path Doctor contract available during an update rehearsal", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const rehearsalRoot = path.join(home, ".openclaw");
      const pluginRoot = path.join(rehearsalRoot, "copied-custom-plugin");
      const pluginId = "copied-custom-fixture";
      await installStatelessFixture(pluginRoot, pluginId, "config-only");
      await writeOpenClawConfig(home, createPluginConfig(pluginId, undefined, [pluginRoot]));

      await withEnvAsync(
        {
          ...buildUpdateRehearsalPathEnv(rehearsalRoot),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        },
        async () => {
          const result = await runDoctorConfigPreflight(doctorOptions);
          expect(result.deferredPluginMigrations).toBeUndefined();
          expect(readDeferredPluginMigrations()).toEqual([]);
        },
      );
    });
  });

  it("preserves a newer migration obligation after an ordinary Doctor observed a stateless plugin", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginRoot = path.join(home, "upgraded-plugin");
      const source = path.join(home, "legacy-binding.json");
      const migrated = path.join(home, "migrated-binding.json");
      const pluginId = "upgraded-fixture";
      const config = createPluginConfig(pluginId, { legacyBinding: source });
      await writeOpenClawConfig(home, config);
      await fs.writeFile(source, '{"binding":"retained"}\n');
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight(doctorOptions);
        expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
        await installStatelessFixture(pluginRoot, pluginId);
        await writeOpenClawConfig(home, {
          ...config,
          plugins: { ...config.plugins, load: { paths: [pluginRoot] } },
        });
        let upgraded = false;
        const result = await runDoctorConfigPreflight({
          ...doctorOptions,
          measure: async (name, run) => {
            const measured = await run();
            if (name === "doctor.config-preflight.legacy-state-migrations" && !upgraded) {
              upgraded = true;
              await installMigrationFixture({
                root: pluginRoot,
                pluginId,
                source,
                migrated,
                phase: "after-session-repair",
              });
              await runDoctorConfigPreflight(doctorOptions);
              expect(readDeferredPluginMigrations()).toEqual([
                expect.objectContaining({ pluginId, requiresStateMigration: true }),
              ]);
            }
            return measured;
          },
        });
        expect(upgraded).toBe(true);
        expect(readDeferredPluginMigrations()).toEqual([
          expect.objectContaining({ pluginId, requiresStateMigration: true }),
        ]);
        expect(result.snapshot.valid).toBe(true);
        expect(result.stateMigrationStepReceipts).toContainEqual(
          expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
        );
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toHaveProperty(
          `plugins.entries.${pluginId}.config.legacyBinding`,
          source,
        );
        expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
        await expect(fs.stat(migrated)).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });

  it.each([false, true])(
    "honors the allowlist for ambient channel credentials (Discord allowed: %s)",
    async (allowDiscord) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const pluginId = "missing-fixture";
        const config = createPluginConfig(pluginId);
        if (allowDiscord) {
          config.plugins.allow.push("discord");
        }
        await writeOpenClawConfig(home, config);
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            DISCORD_BOT_TOKEN: "synthetic-discord-token",
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const result = await runDoctorConfigPreflight(doctorOptions);
            expect(result.snapshot.valid).toBe(true);
            const pending = readDeferredPluginMigrations();
            expect(pending.map((entry) => entry.pluginId)).toEqual(
              allowDiscord ? ["discord", pluginId] : [pluginId],
            );
            expect(result.stateMigrationStepReceipts).toContainEqual(
              expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
            );
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
      });
    },
  );

  it("keeps an existing obligation when only the full entry declares a detector", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const pluginId = "full-entry-detector-fixture";
      const pluginRoot = path.join(home, pluginId);
      const config = createPluginConfig(pluginId, { region: "us-en" }, [pluginRoot]);
      await writeOpenClawConfig(home, config);
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await writeOpenClawConfig(home, {
          ...config,
          plugins: { ...config.plugins, load: { paths: [] } },
        });
        await runDoctorConfigPreflight({
          ...doctorOptions,
          preparePluginMetadataSnapshot: true,
        });
        expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);

        await installStatelessFixture(pluginRoot, pluginId, "public-setup-full-detector");
        await writeOpenClawConfig(home, config);
        const result = await runDoctorConfigPreflight({
          ...doctorOptions,
          preparePluginMetadataSnapshot: true,
        });

        expect(result.snapshot.valid).toBe(true);
        expect(readDeferredPluginMigrations()).toEqual([
          expect.objectContaining({ pluginId, requiresDoctorInspection: true }),
        ]);
        expect(
          (await readConfigFileSnapshot()).sourceConfig.plugins?.entries?.[pluginId]?.config,
        ).toEqual({
          region: "us-en",
        });
      });
    });
  });

  it("confirms an installed stateless plugin with a retained disabled-channel obligation", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const pluginId = "retained-fixture";
      const pluginRoot = path.join(home, pluginId);
      const config = createPluginConfig(pluginId, { region: "us-en" });
      await writeOpenClawConfig(home, config);
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight(doctorOptions);
        expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
        await installStatelessFixture(pluginRoot, pluginId, "absent", true);
        const otherId = "configured-fixture";
        const otherRoot = path.join(home, otherId);
        await installStatelessFixture(otherRoot, otherId);
        const installedConfig = {
          ...config,
          channels: { [pluginId]: { enabled: false } },
          plugins: {
            ...config.plugins,
            allow: [pluginId, otherId],
            load: { paths: [pluginRoot, otherRoot] },
            entries: {
              ...config.plugins.entries,
              [otherId]: { enabled: true },
            },
          },
        };
        await writeOpenClawConfig(home, installedConfig);
        const result = await runDoctorConfigPreflight(doctorOptions);
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
      });
    });
  });

  it("settles inspection-only debt when the installed plugin has no migration contract", async () => {
    const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    onTestFinished(() => note.mockRestore());
    await withDoctorConfigPreflightHome(async (home) => {
      const pluginRoot = path.join(home, "inspection-plugin");
      const pluginId = "inspection-fixture";
      const config = createPluginConfig(pluginId, { region: "us-en" });
      await writeOpenClawConfig(home, config);
      const options = {
        ...doctorOptions,
        preparePluginMetadataSnapshot: true,
      } as const;
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight(options);
        await installStatelessFixture(pluginRoot, pluginId, "broken");
        await writeOpenClawConfig(home, {
          ...config,
          plugins: { ...config.plugins, load: { paths: [pluginRoot] } },
        });
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([
          expect.objectContaining({ pluginId, requiresDoctorInspection: true }),
        ]);
        await fs.unlink(path.join(pluginRoot, "doctor-contract-api.cjs"));
        await installStatelessFixture(pluginRoot, pluginId);
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const original = await fs.readFile(configPath, "utf8");
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([]);
        expect(note).toHaveBeenCalledWith(
          '- Plugin "inspection-fixture" version "1.0.0": no plugin migration contract. No migration ran; existing data and settings have been kept.',
          "Doctor warnings",
        );
        const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        const { DatabaseSync } = requireNodeSqlite();
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const row = database
            .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
            .get(`deferred-plugin-migration:${pluginId}`);
          expect(row?.status).toBe("completed");
          expect(JSON.parse(String(row?.report_json))).toMatchObject({
            reason: expect.stringContaining("no plugin migration contract"),
          });
        } finally {
          database.close();
        }
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([]);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect((await readConfigFileSnapshot()).warnings).toEqual([]);
      });
    });
  });

  it("retires same-Doctor deferral inputs with prepared metadata", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginRoot = path.join(home, "fixture-plugin");
      const source = path.join(home, "legacy-binding.json");
      const migrated = path.join(home, "migrated-binding.json");
      const pluginId = "deferred-fixture";
      await fs.writeFile(source, '{"binding":"retained"}\n');
      await writeOpenClawConfig(
        home,
        createPluginConfig(pluginId, { legacyBinding: source }, [pluginRoot]),
      );
      let installed = false;
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const completed = await runDoctorConfigPreflight({
          ...doctorOptions,
          preparePluginMetadataSnapshot: true,
          measure: async (name, run) => {
            const measured = await run();
            if (name === "doctor.config-preflight.config-snapshot" && !installed) {
              await installMigrationFixture({ root: pluginRoot, pluginId, source, migrated });
              installed = true;
            }
            return measured;
          },
        });
        expect(installed).toBe(true);
        expect(completed.snapshot.issues).toEqual([]);
        expect(await fs.readFile(migrated, "utf8")).toBe('{"binding":"retained"}\n');
        expect(completed.snapshot.valid).toBe(true);
        expect(readDeferredPluginMigrations()).toEqual([]);
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).not.toHaveProperty(
          `plugins.entries.${pluginId}.config.legacyBinding`,
        );
        expect((await readConfigFileSnapshot()).valid).toBe(true);
      });
    });
  });

  it.each(["doctor", "stale-candidate", "published-candidate"] as const)(
    "%s preserves pending inputs and retries after the package becomes available",
    async (entry) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "fixture-plugin");
        const currentPluginRoot = path.join(home, "fixture-plugin-current");
        const source = path.join(home, "legacy-binding.json");
        const migrated = path.join(home, "migrated-binding.json");
        const pluginId = "deferred-fixture";
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
          await installMigrationFixture({
            root: pluginRoot,
            pluginId,
            source,
            migrated,
            stale: true,
          });
        }
        await writeOpenClawConfig(home, config);
        await fs.writeFile(source, '{"binding":"retained"}\n');
        const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
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
        const options = {
          ...(entry === "published-candidate"
            ? { observe: false, preparePluginMetadataSnapshot: true }
            : {}),
          ...doctorOptions,
        } as const;
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: entry.endsWith("candidate") ? "1" : undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: entry.endsWith("candidate")
              ? "1"
              : undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const pending = await runDoctorConfigPreflight(options);
            expect(pending.stateMigrationStepReceipts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: `plugin:${pluginId}`,
                  outcome: "deferred",
                  warnings: [expect.stringContaining("openclaw update repair")],
                }),
              ]),
            );
            expect(readDeferredPluginMigrations()).toEqual([
              expect.objectContaining({ pluginId, command: "openclaw update repair" }),
            ]);
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
            if (entry === "published-candidate") {
              await closeOpenClawStateDatabaseByPathAsync(databasePath);
              expect(readDeferredPluginMigrations()).toEqual([
                expect.objectContaining({ pluginId, command: "openclaw update repair" }),
              ]);
              const { DatabaseSync } = requireNodeSqlite();
              const database = new DatabaseSync(databasePath, { readOnly: true });
              try {
                expect(database.prepare("PRAGMA user_version").get()).toEqual({
                  user_version: OPENCLAW_STATE_SCHEMA_VERSION,
                });
                expect(
                  database
                    .prepare("SELECT sequence, event_id FROM audit_events WHERE event_id = ?")
                    .get("fixture-audit-event"),
                ).toEqual({ sequence: 7, event_id: "fixture-audit-event" });
              } finally {
                database.close();
              }
            }
            if (entry === "stale-candidate") {
              await expect(fs.stat(path.join(pluginRoot, "stale-called"))).rejects.toMatchObject({
                code: "ENOENT",
              });
            }
          },
        );

        if (entry === "stale-candidate") {
          await fs.rm(pluginRoot, { recursive: true });
          await writeOpenClawConfig(home, {
            ...config,
            plugins: { ...config.plugins, load: { paths: [] } },
          });
          await withEnvAsync(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            },
            async () => {
              const retry = await runDoctorConfigPreflight(options);
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
        await installMigrationFixture({ root: currentPluginRoot, pluginId, source, migrated });
        if (entry === "doctor") {
          await writeOpenClawConfig(home, {
            ...config,
            plugins: {
              ...config.plugins,
              entries: { [pluginId]: { ...config.plugins.entries[pluginId], enabled: false } },
              load: { paths: [currentPluginRoot] },
            },
          });
          await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
            await runDoctorConfigPreflight(options);
            expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
            expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
          });
        }
        await writeOpenClawConfig(home, {
          ...config,
          plugins: { ...config.plugins, load: { paths: [currentPluginRoot] } },
        });
        if (entry === "doctor") {
          const manifestPath = path.join(currentPluginRoot, "openclaw.plugin.json");
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          await fs.rm(path.join(currentPluginRoot, "doctor-contract-api.cjs"));
          for (const contract of ["absent", "declared-empty", "empty-module"]) {
            await fs.writeFile(
              manifestPath,
              JSON.stringify({
                ...manifest,
                doctorContract: contract === "absent" ? undefined : { stateMigrations: [] },
              }),
            );
            if (contract === "empty-module") {
              await fs.writeFile(
                path.join(currentPluginRoot, "doctor-contract-api.cjs"),
                "module.exports = { stateMigrations: [], normalizeCompatibilityConfig: ({cfg}) => ({config: cfg, changes: []}) };\n",
              );
            }
            await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
              const unfinished = await runDoctorConfigPreflight(options);
              expect(readDeferredPluginMigrations()).toEqual([
                expect.objectContaining({ pluginId }),
              ]);
              expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
              expect(unfinished.stateMigrationStepReceipts).toContainEqual(
                expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
              );
            });
          }
          const resumedPluginRoot = path.join(home, "fixture-plugin-resumed");
          await installMigrationFixture({ root: resumedPluginRoot, pluginId, source, migrated });
          await writeOpenClawConfig(home, {
            ...config,
            plugins: { ...config.plugins, load: { paths: [resumedPluginRoot] } },
          });
        }
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const completed = await runDoctorConfigPreflight(options);
            expect(await fs.readFile(migrated, "utf8")).toBe('{"binding":"retained"}\n');
            expect(readDeferredPluginMigrations()).toEqual([]);
            expect(
              completed.stateMigrationStepReceipts?.filter(
                (receipt) => receipt.outcome === "deferred",
              ),
            ).toEqual([]);
          },
        );
      });
    },
  );
});
