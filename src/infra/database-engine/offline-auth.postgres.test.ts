import "../../commands/models/auth.js";
import "../../commands/models/auth-list.js";
import "../../commands/models/auth-order.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAuthProfileStoreForRuntimeAsync,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
} from "../../agents/auth-profiles/store-runtime.js";
import { prepareCliDatabaseEngine } from "../../cli/database-engine-selection.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import { ensureConfigReady } from "../../cli/program/config-guard.js";
import { agentsDeleteCommand } from "../../commands/agents.commands.delete.js";
import { assertCronStateSchemaSupported } from "../../commands/doctor/cron/schema-safety.js";
import { inspectCronOwnerRowsForDoctor } from "../../commands/doctor/cron/store-inventory.js";
import { saveModelProviderApiKey } from "../../commands/models/auth-api-key.js";
import { runStartupConfigPreflight } from "../../commands/startup-config-preflight.js";
import { captureConfigHealthStateStore } from "../../config/io.health-state.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import { saveCronJobsStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  inspectCronJobsReadOnly,
  loadCronJobsStoreWithConfigJobsReadOnly,
} from "../../cron/store/read-only.js";
import type { CronStoreFile } from "../../cron/types.js";
import {
  createPluginCache,
  retirePluginCache,
  runOutsidePluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const password = vi.hoisted(() => vi.fn(async () => "sk-synthetic-offline-cli-key"));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password,
}));
// mock-isolation: This offline proof must not send credential-refresh RPCs to a running Gateway.
vi.mock("../../commands/models/auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: async () => "unavailable",
}));

afterEach(async () => {
  await closeStateDatabaseForTest();
  resetConfigRuntimeState();
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
});

async function withDatabase(
  label: string,
  run: (client: pg.Client, prefix: string) => Promise<void>,
) {
  const prefix = `${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await withPostgresConnection(
    { connection: connection!, schemaPrefix: prefix },
    async (client) => {
      try {
        await run(client, prefix);
      } finally {
        await closeStateDatabaseForTest();
        resetDatabaseEngineSelectionForTest();
        await dropPostgresTestSchemas(client, prefix);
      }
    },
  );
}

describe.skipIf(!connection)("offline CLI on PostgreSQL", () => {
  it("selects PostgreSQL before auth, persists a key, and leaves Gateway admission usable", async () => {
    await withDatabase("cli", async (client, prefix) => {
      await withOpenClawTestState(
        { label: "postgres-offline-auth", env: { OPENCLAW_TEST_AUTH_DSN: connection } },
        async (state) => {
          await state.writeConfig({
            database: {
              engine: "postgres",
              postgres: {
                connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_AUTH_DSN" },
                schemaPrefix: prefix,
              },
            },
            gateway: { mode: "local" },
            agents: { entries: { main: { workspace: state.workspaceDir } } },
            models: {
              providers: {
                openai: {
                  baseUrl: "http://127.0.0.1:9/v1",
                  models: [],
                  apiKey: "openai:offline",
                },
              },
            },
            plugins: { enabled: false },
            meta: { migrations: { webhookListeners: true } },
          });
          vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
          const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
          vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
            throw new ExitError(code);
          });
          const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
          Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
          try {
            await prepareCliDatabaseEngine(["node", "openclaw", "models", "auth", "paste-api-key"]);
            await ensureConfigReady({
              runtime: defaultRuntime,
              commandPath: ["models", "auth", "paste-api-key"],
            });
            await expect(agentsDeleteCommand({ id: "main", force: true })).rejects.toBeInstanceOf(
              ExitError,
            );
            expect(error).toHaveBeenCalledWith(
              'Agent "main" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry.',
            );
            const run = async (...args: string[]) => {
              const program = new Command().enablePositionalOptions();
              registerModelsCli(program);
              await program.parseAsync(["models", "auth", ...args], { from: "user" });
            };
            await run(
              "paste-api-key",
              "--provider",
              "openai",
              "--profile-id",
              "openai:offline",
              "--agent",
              "main",
            );
            const readCold = async <T>(read: () => Promise<T>) => {
              const cache = createPluginCache();
              try {
                return await runOutsidePluginCache(() => withPluginCache(cache, read));
              } finally {
                await retirePluginCache(cache);
              }
            };
            await readCold(() => run("list", "--agent", "main", "--json"));
            await run("order", "set", "--provider", "openai", "--agent", "main", "openai:offline");
            await mkdir(state.agentDir("reader"), { recursive: true });
            await saveModelProviderApiKey({
              provider: "openai",
              apiKey: "sk-synthetic-offline-cli-replacement",
              agentDir: state.agentDir(),
            });
            const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir());
            const runtimeStore = await readCold(() =>
              loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
                readOnly: true,
                allowKeychainPrompt: false,
              }),
            );
            expect(runtimeStore.profiles["openai:offline"]).toEqual(
              store.profiles["openai:offline"],
            );
            expect(store.profiles["openai:offline"]).toMatchObject({
              type: "api_key",
              provider: "openai",
              key: "sk-synthetic-offline-cli-replacement",
            });
            expect(store.order?.openai).toEqual(["openai:offline"]);
            const health = captureConfigHealthStateStore(
              { env: state.env, homedir: () => state.home, logger: console },
              state.configPath,
            );
            const previous = await health.read();
            if (!previous) {
              throw new Error("Config health observation was not admitted");
            }
            await health.update(
              { lastObservedSuspiciousSignature: "synthetic-observation" },
              previous,
            );
            expect(
              (await health.read())?.state.entries?.[state.configPath]
                ?.lastObservedSuspiciousSignature,
            ).toBe("synthetic-observation");
            using anchor = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env), {
              readOnly: true,
            });
            expect(
              anchor
                .prepare(
                  "SELECT name FROM sqlite_master WHERE name IN ('schema_meta', 'config_machine_state')",
                )
                .all(),
            ).toEqual([]);
            const identity = anchor
              .prepare("SELECT engine, schema FROM openclaw_engine_anchor")
              .get();
            expect(identity?.engine).toBe("postgres");
            const schema = String(identity?.schema).replaceAll('"', '""');
            const persisted = await client.query(
              `SELECT value_json::jsonb -> 'profiles' -> 'openai:offline' AS profile FROM "${schema}".config_machine_state WHERE state_key = 'authProfiles.store'`,
            );
            expect(persisted.rows).toEqual([{ profile: store.profiles["openai:offline"] }]);
            const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
            await ready.pluginCache?.[Symbol.asyncDispose]();
            expect(ready.snapshot.valid).toBe(true);
          } finally {
            if (tty) {
              Object.defineProperty(process.stdin, "isTTY", tty);
            } else {
              Reflect.deleteProperty(process.stdin, "isTTY");
            }
          }
        },
      );
    });
  });
});

describe.skipIf(!connection)("PostgreSQL cron read-only owner", () => {
  it("loads jobs and Doctor inventory through PostgreSQL while retaining an anchor-only local store", async () => {
    await withDatabase("cron_read", async (_client, prefix) => {
      await withOpenClawTestState({ label: "postgres-cron-read-only" }, async (state) => {
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
          }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        });
        const storePath = state.statePath("cron", "jobs.json");
        const store: CronStoreFile = {
          version: 1,
          jobs: [
            {
              id: "postgres-read-only",
              name: "persisted PostgreSQL job",
              enabled: true,
              agentId: "main",
              createdAtMs: 1,
              updatedAtMs: 2,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "synthetic event" },
              state: { nextRunAtMs: 60_001 },
            },
          ],
        };
        await saveCronJobsStore(storePath, store);
        await closeStateDatabaseForTest();
        const ownerRows = withEngineStoreAdmission(() => {
          assertCronStateSchemaSupported(state.env);
          return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
            ({ db }) => inspectCronOwnerRowsForDoctor(db, cronStoreKey(storePath)),
            { env: state.env },
          );
        });
        expect(ownerRows).toEqual([
          expect.objectContaining({ job_id: "postgres-read-only", agent_id: "main" }),
        ]);
        for (const preserveArtifacts of [false, true]) {
          const read = () => loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
          const loaded = await (preserveArtifacts
            ? withArtifactPreservingStateReads(read)
            : read());
          expect([loaded.store, loaded.invalidConfigRows]).toEqual([store, []]);
        }
        expect(await inspectCronJobsReadOnly(state.env)).toEqual([
          expect.objectContaining({ id: "postgres-read-only", definition: expect.any(Object) }),
        ]);
        using anchor = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env), {
          readOnly: true,
        });
        expect(
          anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
        ).toEqual([{ name: "openclaw_engine_anchor" }]);
      });
    });
  });
});
