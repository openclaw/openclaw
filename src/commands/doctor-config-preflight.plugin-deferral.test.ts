import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

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
  contract:
    | "absent"
    | "declared-empty"
    | "config-only"
    | "broken"
    | "setup-only"
    | "setup-invalid-detector"
    | "setup-broken" = "absent",
) {
  const setup =
    contract === "setup-only" ||
    contract === "setup-broken" ||
    contract === "setup-invalid-detector";
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
  await fs.writeFile(path.join(root, "index.cjs"), "module.exports = {};\n");
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      ...(setup
        ? {
            channels: [pluginId],
            channelConfigs: {
              [pluginId]: {
                schema: { type: "object", properties: {}, additionalProperties: false },
              },
            },
          }
        : {}),
      ...(contract === "declared-empty" ? { doctorContract: { stateMigrations: [] } } : {}),
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
        : contract === "declared-empty"
          ? "module.exports = { stateMigrations: [] };\n"
          : "module.exports = { normalizeCompatibilityConfig: ({ cfg }) => ({ config: cfg, changes: [] }) };\n",
    );
  }
  if (setup) {
    await fs.writeFile(
      path.join(root, "setup-entry.cjs"),
      contract === "setup-broken"
        ? 'throw new Error("Fixture setup contract unavailable");\n'
        : contract === "setup-invalid-detector"
          ? 'module.exports = { kind: "bundled-channel-setup-entry", loadSetupPlugin() { return {}; }, loadLegacyStateMigrationDetector() { return undefined; } };\n'
          : 'module.exports = { kind: "bundled-channel-setup-entry", loadSetupPlugin() { return {}; } };\n',
    );
  }
}

describe("configured plugin migration deferral", () => {
  it("preserves a newer migration obligation after an ordinary Doctor observed a stateless plugin", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginRoot = path.join(home, "upgraded-plugin");
      const source = path.join(home, "legacy-binding.json");
      const migrated = path.join(home, "migrated-binding.json");
      const pluginId = "upgraded-fixture";
      const config = {
        gateway: { mode: "local" },
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true, config: { legacyBinding: source } } },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(source, '{"binding":"retained"}\n');
      const options = {
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        repairPrefixedConfig: true,
      } as const;
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
        await installStatelessFixture(pluginRoot, pluginId);
        await fs.writeFile(
          configPath,
          JSON.stringify({
            ...config,
            plugins: { ...config.plugins, load: { paths: [pluginRoot] } },
          }),
        );
        let upgraded = false;
        const result = await runDoctorConfigPreflight({
          ...options,
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
              await runDoctorConfigPreflight(options);
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
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginId = "missing-fixture";
        const config = {
          gateway: { mode: "local" },
          plugins: {
            allow: allowDiscord ? [pluginId, "discord"] : [pluginId],
            entries: { [pluginId]: { enabled: true } },
          },
        };
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config));
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            DISCORD_BOT_TOKEN: "synthetic-discord-token",
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const result = await runDoctorConfigPreflight({
              migrateLegacyConfig: false,
              invalidConfigNote: false,
              doctorOnlyStateMigrations: true,
              repairPrefixedConfig: true,
            });
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

  it.each([
    { preparePluginMetadataSnapshot: true, contract: "absent" as const, nextDoctor: false },
    { preparePluginMetadataSnapshot: false, contract: "absent" as const, nextDoctor: false },
    { preparePluginMetadataSnapshot: true, contract: "declared-empty" as const, nextDoctor: false },
    { preparePluginMetadataSnapshot: true, contract: "config-only" as const, nextDoctor: false },
    { preparePluginMetadataSnapshot: true, contract: "setup-only" as const, nextDoctor: false },
    { preparePluginMetadataSnapshot: true, contract: "absent" as const, nextDoctor: true },
  ])(
    "clears installation-only deferral for $contract (metadata=$preparePluginMetadataSnapshot, next Doctor=$nextDoctor)",
    async ({ preparePluginMetadataSnapshot, contract, nextDoctor }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "stateless-plugin");
        const pluginId = "stateless-fixture";
        const config = {
          gateway: { mode: "local" },
          plugins: {
            allow: [pluginId],
            entries: { [pluginId]: { enabled: true, config: { region: "us-en" } } },
            load: { paths: [pluginRoot] },
          },
        };
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config));
        let installed = false;
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          if (nextDoctor) {
            await fs.writeFile(
              configPath,
              JSON.stringify({
                ...config,
                plugins: { ...config.plugins, load: { paths: [] } },
              }),
            );
            await runDoctorConfigPreflight({
              migrateLegacyConfig: false,
              invalidConfigNote: false,
              doctorOnlyStateMigrations: true,
              repairPrefixedConfig: true,
              preparePluginMetadataSnapshot,
            });
            expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
            await installStatelessFixture(pluginRoot, pluginId, contract);
            installed = true;
            await fs.writeFile(configPath, JSON.stringify(config));
          }
          const result = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            doctorOnlyStateMigrations: true,
            repairPrefixedConfig: true,
            preparePluginMetadataSnapshot,
            beforeStateMigrations: async (snapshot) => {
              if (snapshot && !installed) {
                await installStatelessFixture(pluginRoot, pluginId, contract);
                installed = true;
              }
              return true;
            },
          });
          expect(installed).toBe(true);
          expect(result.snapshot.valid).toBe(true);
          expect(readDeferredPluginMigrations()).toEqual([]);
          const checked = await readConfigFileSnapshot();
          expect(checked.valid).toBe(true);
          expect(checked.warnings).toEqual([]);
          expect(checked.sourceConfig.plugins?.entries?.[pluginId]?.config).toEqual({
            region: "us-en",
          });
        });
      });
    },
  );

  it.each(["doctor", "setup", "setup-invalid-detector"] as const)(
    "keeps failed %s inspection debt after the artifact disappears",
    async (kind) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "inspection-plugin");
        const pluginId = "inspection-fixture";
        const config = {
          gateway: { mode: "local" },
          plugins: {
            allow: [pluginId],
            entries: { [pluginId]: { enabled: true, config: { region: "us-en" } } },
          },
        };
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config));
        const options = {
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          doctorOnlyStateMigrations: true,
          repairPrefixedConfig: true,
          preparePluginMetadataSnapshot: true,
        } as const;
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          await runDoctorConfigPreflight(options);
          await installStatelessFixture(
            pluginRoot,
            pluginId,
            kind === "doctor"
              ? "broken"
              : kind === "setup-invalid-detector"
                ? kind
                : "setup-broken",
          );
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: { ...config.plugins, load: { paths: [pluginRoot] } },
            }),
          );
          await runDoctorConfigPreflight(options);
          expect(readDeferredPluginMigrations()).toEqual([
            expect.objectContaining({ pluginId, requiresDoctorInspection: true }),
          ]);
          await fs.unlink(
            path.join(
              pluginRoot,
              kind === "doctor" ? "doctor-contract-api.cjs" : "setup-entry.cjs",
            ),
          );
          await installStatelessFixture(pluginRoot, pluginId);
          await runDoctorConfigPreflight(options);
          expect(readDeferredPluginMigrations()).toEqual([
            expect.objectContaining({ pluginId, requiresDoctorInspection: true }),
          ]);
          await installStatelessFixture(
            pluginRoot,
            pluginId,
            kind === "doctor" ? "config-only" : "setup-only",
          );
          await runDoctorConfigPreflight(options);
          expect(readDeferredPluginMigrations()).toEqual([]);
          expect((await readConfigFileSnapshot()).warnings).toEqual([]);
        });
      });
    },
  );

  it("retains a required migration learned while the installed plugin is disabled", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginRoot = path.join(home, "learned-plugin");
      const source = path.join(home, "legacy-binding.json");
      const migrated = path.join(home, "migrated-binding.json");
      const pluginId = "learned-fixture";
      const entry = { enabled: true, config: { legacyBinding: source } };
      const config = {
        gateway: { mode: "local" },
        plugins: { allow: [pluginId], entries: { [pluginId]: entry } },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(source, '{"binding":"retained"}\n');
      const options = {
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        repairPrefixedConfig: true,
        preparePluginMetadataSnapshot: true,
      } as const;
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
        await installMigrationFixture({ root: pluginRoot, pluginId, source, migrated });
        const loadedPlugins = { ...config.plugins, load: { paths: [pluginRoot] } };
        await fs.writeFile(
          configPath,
          JSON.stringify({
            ...config,
            plugins: { ...loadedPlugins, entries: { [pluginId]: { ...entry, enabled: false } } },
          }),
        );
        await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([
          expect.objectContaining({ pluginId, requiresStateMigration: true }),
        ]);
        expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');

        await fs.unlink(path.join(pluginRoot, "doctor-contract-api.cjs"));
        await installStatelessFixture(pluginRoot, pluginId);
        await fs.writeFile(configPath, JSON.stringify({ ...config, plugins: loadedPlugins }));
        const retained = await runDoctorConfigPreflight(options);
        expect(retained.snapshot.valid).toBe(true);
        expect(readDeferredPluginMigrations()).toEqual([
          expect.objectContaining({ pluginId, requiresStateMigration: true }),
        ]);
        expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
        expect(retained.snapshot.sourceConfig.plugins?.entries?.[pluginId]?.config).toEqual(
          entry.config,
        );
      });
    });
  });

  it.each([true, false])(
    "retires same-Doctor deferral inputs with prepared metadata: %s",
    async (preparePluginMetadataSnapshot) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const pluginRoot = path.join(home, "fixture-plugin");
        const source = path.join(home, "legacy-binding.json");
        const migrated = path.join(home, "migrated-binding.json");
        const pluginId = "deferred-fixture";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(source, '{"binding":"retained"}\n');
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: { mode: "local" },
            plugins: {
              allow: [pluginId],
              entries: { [pluginId]: { enabled: true, config: { legacyBinding: source } } },
              load: { paths: [pluginRoot] },
            },
          }),
        );
        let installed = false;
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const completed = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            doctorOnlyStateMigrations: true,
            repairPrefixedConfig: true,
            preparePluginMetadataSnapshot,
            beforeStateMigrations: async (snapshot) => {
              if (snapshot && !installed) {
                await installMigrationFixture({ root: pluginRoot, pluginId, source, migrated });
                installed = true;
              } else if (snapshot) {
                expect(readDeferredPluginMigrations()).toEqual([
                  expect.objectContaining({ pluginId }),
                ]);
              }
              return true;
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
    },
  );

  it.each(["doctor", "startup", "candidate", "stale-candidate", "published-candidate"] as const)(
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
          gateway: { mode: "local" },
          agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
          ...(entry === "stale-candidate" ? { legacyFixture: source } : {}),
          plugins: {
            allow: [pluginId],
            entries: { [pluginId]: { enabled: true, config: { legacyBinding: source } } },
            ...(entry === "stale-candidate" ? { load: { paths: [pluginRoot] } } : {}),
          },
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
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config));
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
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          doctorOnlyStateMigrations: entry !== "startup",
          repairPrefixedConfig: true,
          requireStartupMigrationCheckpoint: entry === "startup",
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
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: { ...config.plugins, load: { paths: [] } },
            }),
          );
          await withEnvAsync(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            },
            async () => {
              const retry = await runDoctorConfigPreflight({
                ...options,
                requireStartupMigrationCheckpoint: true,
              });
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
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: {
                ...config.plugins,
                entries: { [pluginId]: { ...config.plugins.entries[pluginId], enabled: false } },
                load: { paths: [currentPluginRoot] },
              },
            }),
          );
          await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
            await runDoctorConfigPreflight(options);
            expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
            expect(await fs.readFile(source, "utf8")).toBe('{"binding":"retained"}\n');
          });
        }
        await fs.writeFile(
          configPath,
          JSON.stringify({
            ...config,
            plugins: { ...config.plugins, load: { paths: [currentPluginRoot] } },
          }),
        );
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
              const unfinished = await runDoctorConfigPreflight({
                ...options,
                requireStartupMigrationCheckpoint: true,
              });
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
          await fs.writeFile(
            configPath,
            JSON.stringify({
              ...config,
              plugins: { ...config.plugins, load: { paths: [resumedPluginRoot] } },
            }),
          );
        }
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            const completed = await runDoctorConfigPreflight({
              ...options,
              doctorOnlyStateMigrations: true,
            });
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
