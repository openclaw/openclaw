import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { withPostgresConnection } from "../infra/database-engine/postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  readDeferredPluginMigrationReceipt,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { writeArtifacts } from "../plugins/public-surface.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";

async function checkWebProvider(database: OpenClawConfig["database"], publishReceipt: boolean) {
  await withOpenClawTestState(
    {
      label: "web-provider-secrets",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", FIXTURE_SEARCH_API_KEY: "fixture-key" },
    },
    async ({ env, path }) => {
      const pluginRoot = path("fixture-search");
      writeArtifacts(pluginRoot, {
        "package.json": { name: "fixture-search", openclaw: { extensions: ["./index.cjs"] } },
        "openclaw.plugin.json": {
          id: "fixture-search",
          contracts: { webSearchProviders: ["fixture-search"] },
          configSchema: { type: "object", properties: {} },
        },
        "index.cjs": `module.exports = { id: "fixture-search", register(api) {
          api.registerWebSearchProvider({
            id: "fixture-search", label: "Fixture search", hint: "fixture",
            envVars: [], placeholder: "", signupUrl: "https://example.com",
            credentialPath: "tools.web.search.apiKey",
            getCredentialValue: (search) => search?.apiKey,
            setCredentialValue: (search, value) => { search.apiKey = value; },
            createTool: () => null,
          });
        } };`,
      });
      const config: OpenClawConfig = {
        database,
        plugins: {
          allow: ["fixture-search"],
          load: { paths: [pluginRoot] },
          entries: { "fixture-search": { enabled: true } },
        },
        tools: {
          web: {
            search: {
              provider: "fixture-search",
              apiKey: { source: "env", provider: "default", id: "FIXTURE_SEARCH_API_KEY" },
            },
          },
        },
      };
      try {
        withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
        if (publishReceipt) {
          await recordDeferredPluginMigrations({
            env,
            pending: [
              {
                pluginId: "unrelated-fixture",
                reason: "Retained state needs migration",
                command: "openclaw doctor --fix",
                requiresStateMigration: true,
              },
            ],
          });
        }
        expect(
          Boolean(readDeferredPluginMigrationReceipt(resolveOpenClawStateSqlitePath(env))),
        ).toBe(publishReceipt);

        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          env,
          includeAuthStoreRefs: false,
        });
        expect(snapshot.webTools.search).toMatchObject({
          selectedProvider: "fixture-search",
          selectedProviderKeySource: "secretRef",
        });
        expect(snapshot.config.tools?.web?.search?.apiKey).toBe("fixture-key");
        expect(snapshot.degradedOwners).toEqual([]);
      } finally {
        await closeStateDatabaseForTest();
      }
    },
  );
}

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection).each([false, true])(
  "prepares PostgreSQL web provider secrets on the Gateway thread (migration receipt: %s)",
  async (publishReceipt) => {
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const postgres = {
      connection: connection!,
      schemaPrefix: `secret_test_${randomUUID().slice(0, 8)}`,
    };
    const database = { families: { state: { engine: "postgres" as const } }, postgres };
    await withPostgresConnection(postgres, async (client) => {
      try {
        await withDatabaseEngineSelection(
          { effectiveEngines: resolveDatabaseFamilyEngines({ database }), postgres },
          () => checkWebProvider(database, publishReceipt),
        );
      } finally {
        await dropPostgresTestSchemas(client, postgres.schemaPrefix);
      }
    });
  },
);

it("prepares the same web provider secrets with SQLite", () => checkWebProvider(undefined, false));
