import { expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const connection = { source: "env", provider: "default", id: "DATABASE_DSN" };
function prepare(config: unknown, env = {}, allowUnavailableSecretOwners = false) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env,
    allowUnavailableSecretOwners,
    includeAuthStoreRefs: false,
    loadablePluginOrigins: new Map(),
  });
}

it.each([
  ["omitted default", {}, false],
  ["SQLite default", { engine: "sqlite" }, false],
  ["PostgreSQL default", { engine: "postgres" }, true],
  [
    "PostgreSQL Workboard",
    { engine: "sqlite", families: { workboard: { engine: "postgres" } } },
    true,
  ],
  [
    "all capable families on SQLite",
    {
      engine: "postgres",
      families: Object.fromEntries(
        ["state", "agent", "workboard", "logbook", "team-reports"].map((id) => [
          id,
          { engine: "sqlite" },
        ]),
      ),
    },
    false,
  ],
] as const)(
  "resolves only an effective PostgreSQL connection: %s",
  async (_name, database, active) => {
    const snapshot = await prepare(
      { database: { ...database, postgres: { connection } } },
      active ? { DATABASE_DSN: "postgresql:///fixture" } : {},
    );
    expect(snapshot.config.database?.postgres?.connection).toEqual(
      active ? "postgresql:///fixture" : connection,
    );
    expect(snapshot.warnings.map(({ path }) => path)).toEqual(
      active ? [] : ["database.postgres.connection"],
    );
  },
);

it("refuses a missing PostgreSQL connection secret even with owner isolation enabled", async () => {
  await expect(
    prepare({ database: { engine: "postgres", postgres: { connection } } }, {}, true),
  ).rejects.toThrow('Environment variable "DATABASE_DSN" is missing or empty.');
});

it("skips inactive core refs and emits diagnostics", async () => {
  const snapshot = await prepare({
    memory: {
      search: {
        enabled: false,
        remote: { apiKey: { source: "env", provider: "default", id: "DISABLED_MEMORY_API_KEY" } },
      },
    },
    agents: { defaults: {} },
    gateway: {
      auth: {
        mode: "token",
        password: { source: "env", provider: "default", id: "DISABLED_GATEWAY_PASSWORD" },
      },
    },
  });

  expect(snapshot.warnings.map(({ path }) => path)).toEqual(
    expect.arrayContaining(["memory.search.remote.apiKey", "gateway.auth.password"]),
  );
});
