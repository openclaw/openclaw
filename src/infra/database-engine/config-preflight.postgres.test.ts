import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import { cliRecoveryEntrypoints } from "../../cli/cli-entrypoint.test-support.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "../../commands/doctor-config-preflight.process.test-support.js";
import { runStartupConfigPreflight } from "../../commands/startup-config-preflight.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveBundledPluginPublicModulePath } from "../../test-utils/bundled-plugin-public-surface.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  beginGatewayBootLifecycle,
  completeGatewayBootLifecycle,
} from "../gateway-boot-lifecycle.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { quoteSqliteIdentifier } from "../sqlite-schema-sql.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

async function withHistoricalPostgresState(
  config: Pick<OpenClawConfig, "channels" | "meta">,
  run: (fixture: {
    state: OpenClawTestState;
    source: OpenClawConfig;
    completion: () => Promise<unknown>;
  }) => Promise<void>,
) {
  const prefix = `preflight_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // Resolve the real public contract before redirecting discovery to the narrow fixture.
  const contractPath = resolveBundledPluginPublicModulePath({
    pluginId: "msteams",
    artifactBasename: "config-doctor-api.js",
  });
  await withPostgresConnection(
    { connection: connection!, schemaPrefix: prefix },
    async (client) => {
      try {
        await withOpenClawTestState(
          {
            label: "postgres-historical-preflight",
            env: {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
              OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_UPDATE_REHEARSAL_ROOT: undefined,
              OPENCLAW_PG_PREFLIGHT_DSN: connection,
            },
          },
          async (state) => {
            try {
              const bundledRoot = state.path("bundled");
              const teams = path.join(bundledRoot, "msteams");
              await fs.mkdir(teams, { recursive: true });
              await fs.writeFile(path.join(teams, "package.json"), '{"type":"module"}');
              await fs.writeFile(
                path.join(teams, "openclaw.plugin.json"),
                JSON.stringify({
                  id: "msteams",
                  channels: ["msteams"],
                  configSchema: { type: "object" },
                }),
              );
              for (const entry of ["config-doctor-api.js", "doctor-contract-api.js"]) {
                await fs.writeFile(
                  path.join(teams, entry),
                  `export * from ${JSON.stringify(pathToFileURL(contractPath).href)};\n`,
                );
              }
              state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
              state.applyEnv();
              const source: OpenClawConfig = {
                database: {
                  engine: "postgres",
                  postgres: {
                    connection: {
                      source: "env",
                      provider: "default",
                      id: "OPENCLAW_PG_PREFLIGHT_DSN",
                    },
                    schemaPrefix: prefix,
                  },
                },
                gateway: { mode: "local" },
                plugins: { allow: ["msteams"], entries: { msteams: { enabled: true } } },
                ...config,
              };
              await state.writeConfig(source);
              installDatabaseProcessRole("gateway");
              installDatabaseEngineSelection({
                effectiveEngines: resolveDatabaseFamilyEngines(source),
                postgres: { connection: connection!, schemaPrefix: prefix },
              });
              // Do not run preflight while seeding: that would consume the missing decision.
              const boot = await beginGatewayBootLifecycle(state.env, 1_800_000_000_000);
              expect(boot.id).toEqual(expect.any(String));
              await completeGatewayBootLifecycle(
                boot.id,
                { outcome: "clean_stop" },
                state.env,
                1_800_000_000_001,
              );
              await closeStateDatabaseForTest();
              const anchorPath = resolveOpenClawStateSqlitePath(state.env);
              const readAnchor = () => {
                using anchor = openNodeSqliteDatabase(anchorPath, { readOnly: true });
                return {
                  identity: anchor
                    .prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor")
                    .get(),
                  version: anchor.prepare("PRAGMA user_version").get(),
                };
              };
              const originalAnchor = readAnchor();
              const { identity } = originalAnchor;
              expect(identity?.engine).toBe("postgres");
              expect(typeof identity?.schema).toBe("string");
              const namespace = quoteSqliteIdentifier(String(identity?.schema));
              const metadata = () =>
                client
                  .query(`SELECT store, store_id, version FROM ${namespace}.openclaw_schema_meta`)
                  .then((r) => r.rows);
              const before = await metadata();
              expect(before).toEqual([
                expect.objectContaining({ store: "state", store_id: identity?.store_id }),
              ]);
              const history = () =>
                client
                  .query(`SELECT boot_id, outcome FROM ${namespace}.gateway_boot_lifecycle`)
                  .then((r) => r.rows);
              expect(await history()).toEqual([{ boot_id: boot.id, outcome: "clean_stop" }]);
              const completion = async () => {
                const { rows } = await client.query(
                  `SELECT value_json FROM ${namespace}.config_machine_state WHERE state_key = $1`,
                  [`webhookListeners:${state.configPath}`],
                );
                return rows.length === 0 ? undefined : JSON.parse(rows[0].value_json);
              };
              expect(await completion()).toBeUndefined();
              await run({ state, source, completion });
              await closeStateDatabaseForTest();
              expect(await history()).toEqual([{ boot_id: boot.id, outcome: "clean_stop" }]);
              expect(await metadata()).toEqual(before);
              expect(readAnchor()).toEqual(originalAnchor);
            } finally {
              await closeStateDatabaseForTest();
            }
          },
        );
      } finally {
        await closeStateDatabaseForTest();
        resetDatabaseEngineSelectionForTest();
        await dropPostgresTestSchemas(client, prefix);
      }
    },
  );
}

it.skipIf(!connection)(
  "requires Doctor through gateway run for a historical PostgreSQL listener without completion",
  async () => {
    await withHistoricalPostgresState(
      { channels: { msteams: { enabled: true } } },
      async ({ state, completion }) => {
        const authored = await fs.readFile(state.configPath, "utf8");
        const prepared = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
        const distRoot = fileURLToPath(new URL("./", prepared));
        const runtimeRoot = createBuiltRuntime(state.path("cli"), distRoot, {
          emptyExtensions: true,
        });
        const teams = path.join(runtimeRoot, "dist", "extensions", "msteams");
        await fs.mkdir(teams);
        const packageJson = JSON.parse(
          await fs.readFile("extensions/msteams/package.json", "utf8"),
        );
        // Keep real setup/discovery metadata while matching the prepared graph's ESM output.
        packageJson.openclaw.extensions = ["./index.js"];
        packageJson.openclaw.setupEntry = "./setup-entry.js";
        packageJson.openclaw.build.runtimeFormat = "esm";
        await fs.writeFile(path.join(teams, "package.json"), JSON.stringify(packageJson));
        await fs.copyFile(
          "extensions/msteams/openclaw.plugin.json",
          path.join(teams, "openclaw.plugin.json"),
        );
        for (const entry of await fs.readdir(path.join(distRoot, "extensions", "msteams"))) {
          await fs.copyFile(
            path.join(distRoot, "extensions", "msteams", entry),
            path.join(teams, entry),
          );
        }
        const result = await runBuiltRuntime(
          runtimeRoot,
          {
            ...process.env,
            ...state.envVars,
            // Real CLI startup rejects test-only bundle roots; use production discovery.
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            NODE_ENV: undefined,
            NODE_OPTIONS: undefined,
            VITEST: undefined,
            VITEST_POOL_ID: undefined,
            VITEST_WORKER_ID: undefined,
            OPENCLAW_DEBUG: "1",
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_HIDE_BANNER: "1",
          },
          ["gateway", "run"],
          30_000,
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toMatch(
          /Unable to load host Plugin SDK natively|Failed to load plugin|failed to load (?:channel )?setup/i,
        );
        expect(result, output).toMatchObject({ code: 78, signal: null });
        expect(output).toContain("openclaw doctor --fix");
        expect(output).toContain("Pinned channels.msteams.legacyWebhook");
        expect(await fs.readFile(state.configPath, "utf8")).toBe(authored);
        await expect(fs.stat(`${state.configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await completion()).toBeUndefined();
      },
    );
  },
);

it.skipIf(!connection)(
  "completes a pending PostgreSQL channel once and preserves its decision on restart",
  async () => {
    const prior = { telegram: [], feishu: [], "nextcloud-talk": [] };
    await withHistoricalPostgresState(
      {
        channels: { msteams: { enabled: false } },
        meta: { migrations: { webhookListeners: prior } },
      },
      async ({ state, source, completion }) => {
        const authored = await fs.readFile(state.configPath, "utf8");
        {
          const result = await runStartupConfigPreflight({ gateway: true, observe: false });
          await using caches = new AsyncDisposableStack();
          caches.use(result.pluginCache);
          expect(result.snapshot.valid).toBe(true);
        }
        expect(await completion()).toEqual({ ...prior, msteams: [] });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(authored);
        await closeStateDatabaseForTest();
        resetDatabaseEngineSelectionForTest();
        // Enabling Teams on the next boot must not recreate a listener already decided against.
        await state.writeConfig({ ...source, channels: { msteams: { enabled: true } } });
        const restartConfig = await fs.readFile(state.configPath, "utf8");
        const restarted = await runStartupConfigPreflight({ gateway: true, observe: false });
        await using caches = new AsyncDisposableStack();
        caches.use(restarted.pluginCache);
        expect(restarted.snapshot.valid).toBe(true);
        expect(restarted.snapshot.config.channels?.msteams?.legacyWebhook).toBeUndefined();
        expect(await completion()).toEqual({ ...prior, msteams: [] });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(restartConfig);
      },
    );
  },
);

it.skipIf(!connection)(
  "reports legacy config issues under Gateway PostgreSQL admission",
  async () => {
    expect(threadId).toBe(0);
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const prefix = `preflight_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withPostgresConnection(
      { connection: connection!, schemaPrefix: prefix },
      async (client) => {
        try {
          await withOpenClawTestState({ label: "postgres-config-preflight" }, async (state) => {
            const database = {
              engine: "postgres" as const,
              postgres: { connection: connection!, schemaPrefix: prefix },
            };
            installDatabaseEngineSelection({
              effectiveEngines: resolveDatabaseFamilyEngines({ database }),
              postgres: database.postgres,
            });
            withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
            await closeStateDatabaseForTest();
            await state.writeConfig({
              database,
              gateway: { mode: "local" },
              plugins: { enabled: false },
              agents: { defaults: { heartbeat: { every: "0m" } } },
            });

            const result = await runStartupConfigPreflight({ gateway: true, observe: false });
            expect(result.snapshot.valid).toBe(false);
            expect(result.snapshot.legacyIssues).toContainEqual(
              expect.objectContaining({ path: "agents.defaults.heartbeat" }),
            );
          });
        } finally {
          await closeStateDatabaseForTest();
          resetDatabaseEngineSelectionForTest();
          await dropPostgresTestSchemas(client, prefix);
        }
      },
    );
  },
);
