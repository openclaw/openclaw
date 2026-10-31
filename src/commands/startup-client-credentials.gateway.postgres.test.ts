import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import { readClientCredentialReceipt } from "../infra/client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withPostgresConnection } from "../infra/database-engine/postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareStartupClientCredentials } from "./startup-client-credentials.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "rebinds credentials to a replaced PostgreSQL anchor under Gateway admission",
  async () => {
    expect(threadId).toBe(0);
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const prefix = `credential_gateway_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withPostgresConnection(
      { connection: connection!, schemaPrefix: prefix },
      async (client) => {
        try {
          await withOpenClawTestState({ label: "postgres-credential-gateway" }, async (state) => {
            const config = {
              database: {
                engine: "postgres" as const,
                postgres: { connection: connection!, schemaPrefix: prefix },
              },
            };
            installDatabaseEngineSelection({
              effectiveEngines: resolveDatabaseFamilyEngines(config),
              postgres: config.database.postgres,
            });
            loadOrCreateDeviceIdentity({ env: state.env });
            withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
            await closeStateDatabaseForTest();
            await state.writeConfig(config);
            await prepareStartupClientCredentials({ env: state.env, config });

            // A copied or restored home gives the anchor a new inode, so startup rebinds.
            const anchor = path.join(state.stateDir, "state", "openclaw.sqlite");
            fs.copyFileSync(anchor, `${anchor}.replacement`);
            fs.renameSync(`${anchor}.replacement`, anchor);
            await prepareStartupClientCredentials({ env: state.env, config });

            using owner = openClientCredentialCustody(state.env, {
              readOnly: true,
              migration: true,
            })!;
            expect(readClientCredentialReceipt(owner.database)?.receipt.sharedFile).toEqual(
              readClientCredentialFileIdentity(anchor),
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
  300_000,
);
