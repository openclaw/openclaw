/** Tests inactive core SecretRefs remain unresolved and diagnostic-only. */
import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function expectWarningPaths(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expectedPaths: string[],
): void {
  const warningPaths = new Set(snapshot.warnings.map((warning) => warning.path));
  for (const expectedPath of expectedPaths) {
    expect(warningPaths.has(expectedPath)).toBe(true);
  }
}

describe("secrets runtime snapshot inactive core surfaces", () => {
  it.each([undefined, "sqlite", "postgres"] as const)(
    "resolves the database connection only for PostgreSQL (engine=%s)",
    async (engine) => {
      const connection = { source: "env", provider: "default", id: "DATABASE_DSN" };
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({ database: { engine, postgres: { connection } } }),
        env: engine === "postgres" ? { DATABASE_DSN: "postgresql:///fixture" } : {},
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      });
      expect(snapshot.config.database?.postgres?.connection).toEqual(
        engine === "postgres" ? "postgresql:///fixture" : connection,
      );
      expect(snapshot.warnings.map(({ path }) => path)).toEqual(
        engine === "postgres" ? [] : ["database.postgres.connection"],
      );
    },
  );

  it("refuses a missing PostgreSQL connection secret even with owner isolation enabled", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          database: {
            engine: "postgres",
            postgres: {
              connection: { source: "env", provider: "default", id: "DATABASE_DSN" },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map(),
      }),
    ).rejects.toThrow('Environment variable "DATABASE_DSN" is missing or empty.');
  });

  it("skips inactive core refs and emits diagnostics", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        memory: {
          search: {
            enabled: false,
            remote: {
              apiKey: { source: "env", provider: "default", id: "DISABLED_MEMORY_API_KEY" },
            },
          },
        },

        agents: {
          defaults: {},
        },
        gateway: {
          auth: {
            mode: "token",
            password: { source: "env", provider: "default", id: "DISABLED_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expectWarningPaths(snapshot, ["memory.search.remote.apiKey", "gateway.auth.password"]);
  });
});
