import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { prepareStartupClientCredentials } from "../commands/startup-client-credentials.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareClientCredentialStoreAsync } from "./client-credential-async.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "./database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { withPostgresConnection } from "./database-engine/postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { loadDeviceIdentityIfPresent, loadOrCreateDeviceIdentity } from "./device-identity.js";
import { dropPostgresTestSchemas } from "./postgres-sync/schema-cleanup.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)("starts a restored PostgreSQL home on the first attempt", async () => {
  installDatabaseProcessRole("gateway");
  expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
  const schemaPrefix = `restored_home_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
          withOpenClawTestState({ label: "original-postgres-home" }, async (original) => {
            await original.writeConfig(config);
            const identity = loadOrCreateDeviceIdentity({ env: original.env });
            withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: original.env }));
            await closeStateDatabaseForTest();
            await prepareStartupClientCredentials({ env: original.env, config });
            await closeStateDatabaseForTest();

            await withOpenClawTestState({ label: "restored-postgres-home" }, async (restored) => {
              fs.cpSync(original.stateDir, restored.stateDir, { recursive: true });
              // Both the anchor's path and inode change when a home is restored elsewhere.
              expect(await prepareClientCredentialStoreAsync(restored.env)).toBe("required");
              await expect(
                prepareStartupClientCredentials({ env: restored.env, config }),
              ).resolves.toBeUndefined();
              expect(await prepareClientCredentialStoreAsync(restored.env)).toBe("ready");
              expect(loadDeviceIdentityIfPresent({ env: restored.env })).toEqual(identity);
            });
          }),
      );
    } finally {
      await closeStateDatabaseForTest();
      await dropPostgresTestSchemas(client, schemaPrefix);
    }
  });
});
