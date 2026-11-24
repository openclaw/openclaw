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
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
