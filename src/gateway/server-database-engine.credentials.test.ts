import { afterEach, describe, expect, it } from "vitest";
import {
  sanitizeEnvVars,
  sanitizeExplicitSandboxEnvVars,
} from "../agents/sandbox/sanitize-env-vars.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { sanitizeHostExecEnv, setGatewayCredentialEnvKeys } from "../infra/host-env-security.js";
import { closePostgresPool } from "../infra/postgres-sync/pool.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";

const connection = "postgresql://localhost/private-database-fixture";
const config = (key: string) => ({
  database: {
    engine: "sqlite" as const,
    families: { state: { engine: "postgres" as const } },
    postgres: { connection: { source: "env" as const, provider: "default", id: key } },
  },
});

afterEach(async () => {
  await closePostgresPool();
  resetDatabaseEngineSelectionForTest();
  setGatewayCredentialEnvKeys("database.postgres.connection", []);
});

describe("Gateway database credentials in child environments", () => {
  it.each(["OPENCLAW_DATABASE_DSN", "CUSTOM_STORE_CONNECTION"])(
    "withholds the configured %s source from inherited exec and sandbox environments",
    async (key) => {
      await withOpenClawTestState({ scenario: "minimal", env: { [key]: connection } }, async () => {
        const selected = await resolveDatabaseEngineSelection(config(key));
        await installGatewayDatabaseEngine(undefined, selected);
        const inherited = { PATH: "/synthetic/bin", [key]: connection, SAFE: "ordinary" };
        expect.soft(sanitizeHostExecEnv({ baseEnv: inherited })).not.toHaveProperty(key);
        expect.soft(sanitizeEnvVars(inherited)).toEqual({
          allowed: { PATH: "/synthetic/bin", SAFE: "ordinary" },
          blocked: [key],
          warnings: [],
        });
        expect(
          sanitizeHostExecEnv({ baseEnv: inherited, overrides: { [key]: "requester-owned" } }),
        ).toHaveProperty(key, "requester-owned");
        expect(sanitizeExplicitSandboxEnvVars({ [key]: "operator-configured" }).allowed).toEqual({
          [key]: "operator-configured",
        });
      });
    },
  );

  it("retains the env source after configuration substitution", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { CUSTOM_STORE_CONNECTION: connection } },
      async (state) => {
        await state.writeConfig({
          database: {
            ...config("CUSTOM_STORE_CONNECTION").database,
            postgres: { connection: "${CUSTOM_STORE_CONNECTION}" },
          },
        });
        const snapshot = await readConfigFileSnapshot({
          observe: false,
          isolateEnv: true,
          pluginValidation: "core-only",
        });
        expect(snapshot.valid).toBe(true);
        await installGatewayDatabaseEngine(
          snapshot,
          await resolveDatabaseEngineSelection(snapshot.config),
        );
        const inherited = { CUSTOM_STORE_CONNECTION: connection };
        expect(sanitizeHostExecEnv({ baseEnv: inherited })).not.toHaveProperty(
          "CUSTOM_STORE_CONNECTION",
        );
        expect(sanitizeEnvVars(inherited).allowed).toEqual({});
      },
    );
  });

  it("keeps the installed source protected when another credential source cannot replace it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const first = await resolveDatabaseEngineSelection(config("FIRST_CONNECTION"), {
        FIRST_CONNECTION: connection,
      });
      await installGatewayDatabaseEngine(undefined, first);
      const next = await resolveDatabaseEngineSelection(config("OTHER_CONNECTION"), {
        OTHER_CONNECTION: connection,
      });
      await expect(installGatewayDatabaseEngine(undefined, next)).rejects.toThrow(/restart/);
      expect(sanitizeHostExecEnv({ baseEnv: { FIRST_CONNECTION: connection } })).not.toHaveProperty(
        "FIRST_CONNECTION",
      );
    });
  });

  it("does not retain an old database source in a new SQLite-only process selection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const selected = await resolveDatabaseEngineSelection(config("CUSTOM_STORE_CONNECTION"), {
        CUSTOM_STORE_CONNECTION: connection,
      });
      await installGatewayDatabaseEngine(undefined, selected);
      resetDatabaseEngineSelectionForTest();
      await installGatewayDatabaseEngine(undefined, await resolveDatabaseEngineSelection({}));
      expect(
        sanitizeHostExecEnv({ baseEnv: { CUSTOM_STORE_CONNECTION: connection } }),
      ).toHaveProperty("CUSTOM_STORE_CONNECTION", connection);
    });
  });
});
