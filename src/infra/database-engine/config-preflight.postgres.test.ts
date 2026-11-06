import { randomUUID } from "node:crypto";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import { runStartupConfigPreflight } from "../../commands/startup-config-preflight.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "reports legacy config issues under Gateway PostgreSQL admission",
  async () => {
    expect(threadId).toBe(0);
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const prefix = `preflight_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withPostgresConnection(
      { connection: connection!, schemaPrefix: prefix },
      async (client) => {
        try {
          await withOpenClawTestState({ label: "postgres-config-preflight" }, async (state) => {
            const database = {
              engine: "postgres" as const,
              postgres: { connection: connection!, schemaPrefix: prefix },
            };
            installDatabaseEngineSelection({
              effectiveEngines: resolveDatabaseFamilyEngines({ database }),
              postgres: database.postgres,
            });
            withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
            await closeStateDatabaseForTest();
            await state.writeConfig({
              database,
              gateway: { mode: "local" },
              plugins: { enabled: false },
              agents: { defaults: { heartbeat: { every: "0m" } } },
            });

            const result = await runStartupConfigPreflight({ gateway: true, observe: false });
            expect(result.snapshot.valid).toBe(false);
            expect(result.snapshot.legacyIssues).toContainEqual(
              expect.objectContaining({ path: "agents.defaults.heartbeat" }),
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
);
