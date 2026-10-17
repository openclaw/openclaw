import "../../commands/models/auth.js";
import "../../commands/models/auth-list.js";
import "../../commands/models/auth-order.js";
import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAuthProfileStoreForRuntimeAsync,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
} from "../../agents/auth-profiles/store-runtime.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import { ensureConfigReady } from "../../cli/program/config-guard.js";
import { agentsDeleteCommand } from "../../commands/agents.commands.delete.js";
import { runStartupConfigPreflight } from "../../commands/startup-config-preflight.js";
import { captureConfigHealthStateStore } from "../../config/io.health-state.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import {
  createPluginCache,
  retirePluginCache,
  runOutsidePluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

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

describe.skipIf(!connection)("offline CLI on PostgreSQL", () => {
  it("selects PostgreSQL before auth, persists a key, and leaves Gateway admission usable", async () => {
    const prefix = `cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
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
            await ensureConfigReady({
              runtime: defaultRuntime,
              commandPath: ["models", "auth", "paste-api-key"],
            });
            await expect(
              agentsDeleteCommand({ id: "main", force: true }, defaultRuntime),
            ).rejects.toBeInstanceOf(ExitError);
            expect(error).toHaveBeenCalledWith(
              'Agent "main" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry.',
            );
            const run = async (args: string[]) => {
              const program = new Command().enablePositionalOptions();
              registerModelsCli(program);
              await program.parseAsync(["models", "auth", ...args], { from: "user" });
            };
            await run([
              "paste-api-key",
              "--provider",
              "openai",
              "--profile-id",
              "openai:offline",
              "--agent",
              "main",
            ]);
            const readCold = async <T>(read: () => Promise<T>) => {
              const cache = createPluginCache();
              try {
                return await runOutsidePluginCache(() => withPluginCache(cache, read));
              } finally {
                await retirePluginCache(cache);
              }
            };
            await readCold(() => run(["list", "--agent", "main", "--json"]));
            await run([
              "order",
              "set",
              "--provider",
              "openai",
              "--agent",
              "main",
              "openai:offline",
            ]);
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
              key: "sk-synthetic-offline-cli-key",
            });
            expect(store.order?.openai).toEqual(["openai:offline"]);
            using health = captureConfigHealthStateStore(
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
    } finally {
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
        [prefix + "_"],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
      }
      await client.end();
    }
  });
});
