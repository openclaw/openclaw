import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { withPostgresConnection } from "../infra/database-engine/postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";
import {
  readPluginStateMigrationReadiness,
  readPluginStateMigrationReadinessAsync,
} from "./plugin-state-migration-readiness.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "serves synchronous Gateway plugin loads from readiness a worker already read",
  async () => {
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const schemaPrefix = `plugin_ready_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const config = {
      database: {
        families: { state: { engine: "postgres" as const } },
        postgres: { connection: connection!, schemaPrefix },
      },
    };
    await withPostgresConnection(config.database.postgres, async (client) => {
      try {
        await withDatabaseEngineSelection(
          {
            effectiveEngines: resolveDatabaseFamilyEngines(config),
            postgres: config.database.postgres,
          },
          () =>
            withOpenClawTestState({ label: "plugin-readiness-postgres" }, async (state) => {
              await state.writeConfig(config);
              withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
              // Gateway startup loads plugins asynchronously, so the worker reads the ledger first.
              expect(await readPluginStateMigrationReadinessAsync({ env: state.env })).toEqual([]);
              // Request-time synchronous loads must reuse that result on the Gateway thread.
              expect(readPluginStateMigrationReadiness({ env: state.env })).toEqual([]);
            }),
        );
      } finally {
        await closeStateDatabaseForTest();
        await dropPostgresTestSchemas(client, schemaPrefix);
      }
    });
  },
);

it.skipIf(!connection)(
  "reads npm-pack provenance from PostgreSQL while the Gateway owns state",
  async () => {
    const schemaPrefix = `plugin_inspect_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const postgres = { connection: connection!, schemaPrefix };
    try {
      await withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres,
        },
        () =>
          withOpenClawTestState({ label: "plugin-inspect-postgres" }, async (state) => {
            const database = withEngineStoreAdmission(() =>
              openOpenClawStateDatabase({ env: state.env }),
            );
            const record = {
              source: "npm",
              spec: "fixture@1.0.0",
              artifactKind: "npm-pack",
              sourcePath: "/synthetic/fixture.tgz",
              integrity: "sha512-synthetic",
            };
            withEngineStoreAdmission(() =>
              runOpenClawStateWriteTransaction(
                ({ db }) => {
                  db.prepare(
                    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
                  ).run(
                    "plugins.installedIndex",
                    JSON.stringify({ installRecords: { fixture: record } }),
                    1,
                  );
                },
                { database, env: state.env },
              ),
            );
            await closeStateDatabaseForTest();
            const owner = acquireGatewayStateOwner({
              databasePath: database.path,
              payload: { ...defaultPayload(database.path), role: "gateway" },
            });
            try {
              const row = await readPluginMetadataStateRow("installed-index", { env: state.env });
              expect(JSON.parse(row!.value_json).installRecords.fixture).toEqual(record);
            } finally {
              owner.release();
            }
          }),
      );
    } finally {
      await closeStateDatabaseForTest();
      await withPostgresConnection(postgres, (client) =>
        dropPostgresTestSchemas(client, schemaPrefix),
      );
    }
  },
);
