import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { runStartupConfigPreflight } from "../../commands/startup-config-preflight.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadOrCreateDeviceIdentity } from "../device-identity.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import * as checkpoint from "../startup-migration-checkpoint.js";
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

it.skipIf(!connection).each(["owned", "expired", "revoked"] as const)(
  "handles PostgreSQL startup backup recovery with lease state: %s",
  async (ownership) => {
    expect(threadId).toBe(0);
    installDatabaseProcessRole("gateway");
    const prefix = `recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const postgres = { connection: connection!, schemaPrefix: prefix };
    await withPostgresConnection(postgres, async (client) => {
      try {
        await withOpenClawTestState({ label: "postgres-config-recovery" }, async (state) => {
          const database = { families: { state: { engine: "postgres" as const } }, postgres };
          installDatabaseEngineSelection({
            effectiveEngines: resolveDatabaseFamilyEngines({ database }),
            postgres,
          });
          loadOrCreateDeviceIdentity({ env: state.env });
          withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
          await closeStateDatabaseForTest();
          const original = {
            database,
            plugins: { enabled: false },
            agents: {
              ownership: "explicit",
              entries: { bootstrap: { workspace: state.workspaceDir } },
            },
          };
          const backup = { ...original, gateway: { mode: "local" } };
          await state.writeConfig(original);
          const originalBytes = await fs.readFile(state.configPath, "utf8");
          await fs.writeFile(`${state.configPath}.bak`, JSON.stringify(backup));
          if (ownership !== "owned") {
            const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
            vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementation(
              async (params) => {
                const lease = await acquire(params);
                withEngineStoreAdmission(() =>
                  runOpenClawStateWriteTransaction(
                    ({ db }) => {
                      db.prepare(
                        ownership === "expired"
                          ? "UPDATE state_leases SET expires_at = 0 WHERE scope = 'startup-migrations'"
                          : "DELETE FROM state_leases WHERE scope = 'startup-migrations'",
                      ).run();
                    },
                    { env: state.env },
                  ),
                );
                return lease;
              },
            );
          }
          const ready = runStartupConfigPreflight({ gateway: true, observe: false });
          if (ownership === "owned") {
            expect((await ready).snapshot.valid).toBe(true);
            expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(backup);
          } else {
            await expect(ready).rejects.toBeInstanceOf(checkpoint.StartupMigrationLeaseLostError);
            expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
            expect(
              (await fs.readdir(state.stateDir)).filter((name) => name.includes(".clobbered.")),
            ).toEqual([]);
          }
          const handle = withEngineStoreAdmission(() =>
            openOpenClawStateDatabase({ env: state.env }),
          );
          expect(() => handle.db.prepare("SELECT 1").get()).toThrow("must run in a worker");
        });
      } finally {
        vi.restoreAllMocks();
        await closeStateDatabaseForTest();
        resetDatabaseEngineSelectionForTest();
        await dropPostgresTestSchemas(client, prefix);
      }
    });
  },
);

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
