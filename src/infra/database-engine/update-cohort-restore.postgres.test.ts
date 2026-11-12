import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import {
  capturePostgresBackupInWorker,
  preparePostgresRestoreInWorker,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.operations.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PluginCohortRecovery } from "../update-plugin-cohort-schema.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "../update-run-ledger.js";
import type { UpdateRecoveryRecord } from "../update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  deletePluginCohortRecovery,
  loadPluginCohortRecovery,
} from "../update-run-recovery-store.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { withDatabaseEngineSelection } from "./context.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { readBackupEngineImage } from "./physical-store.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL plugin cohort backup restoration", () => {
  const database = `cohort_restore_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = connection ? new URL(connection) : undefined;
  if (databaseUrl) {
    databaseUrl.pathname = `/${database}`;
  }
  const client = new Client({ connectionString: databaseUrl?.href });
  const sibling = new Client({ connectionString: connection });
  const siblingNamespace = `restore_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    await sibling.connect();
    // The complete orphan inventory must not include other suites' restores.
    await sibling.query(`CREATE DATABASE "${database}"`);
    await client.connect();
    await client.query(
      "CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm; CREATE EXTENSION vector",
    );
  });
  afterAll(async () => {
    try {
      await client.end();
      await sibling.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await sibling.query(`DROP SCHEMA IF EXISTS "${siblingNamespace}" CASCADE`);
    } finally {
      await sibling.end();
    }
  });

  it("retains only the exact post-backup pair through repeat restore and canonical reopen", async () => {
    if (!databaseUrl) {
      throw new Error("PostgreSQL conformance connection is required");
    }
    const isolatedConnection = databaseUrl.href;
    const config = {
      plugins: { enabled: false },
      database: { engine: "postgres" as const, postgres: { connection: isolatedConnection } },
    };
    const selection = {
      effectiveEngines: resolveDatabaseFamilyEngines(config),
      postgres: { connection: isolatedConnection, schemaPrefix: "cohort_restore" },
    };
    await withOpenClawTestState({ label: "cohort-postgres-restore" }, async (state) => {
      await state.writeConfig(config);
      await withDatabaseEngineSelection(selection, async () => {
        const sourcePath = resolveOpenClawStateSqlitePath(state.env);
        const opened = new Set([sourcePath]);
        const admitted = <T>(run: () => T) => withEngineStoreAdmission(run);
        const facts = admitted(() =>
          getPostgresPhysicalFacts(openOpenClawStateDatabase({ env: state.env }).db),
        );
        if (!facts) {
          throw new Error("Fixture did not open the canonical PostgreSQL state owner");
        }
        try {
          const { runId } = admitted(() => createUpdateRun({ trigger: "cli" }, { env: state.env }));
          await seedInstalledPluginIndex(
            { fixture: { source: "npm", version: "1.0.0" } },
            { config, env: state.env },
          );
          admitted(() =>
            writeConfigMachineState(
              "cohort.fixture",
              { generation: "baseline" },
              { env: state.env },
            ),
          );
          const baselineIndex = admitted(() =>
            readConfigMachineState("plugins.installedIndex", { env: state.env }),
          );
          expect(baselineIndex).toMatchObject({
            index: { installRecords: { fixture: { version: "1.0.0" } } },
          });
          await closeOpenClawStateDatabaseByPathAsync(sourcePath);
          expect(
            (
              await client.query<{ state_key: string }>(
                `SELECT state_key FROM "${facts.namespace}".config_machine_state WHERE state_key LIKE 'update.recovery.%' OR state_key LIKE 'update.pluginCohort.%'`,
              )
            ).rows,
          ).toEqual([]);
          const directory = state.path("before-cohort");
          const manifest = await capturePostgresBackupInWorker({
            sourcePath,
            directory,
            config,
            profile: "exact",
            assertCurrent() {},
          });
          expect(readBackupEngineImage(path.join(directory, "anchor.sqlite"), sourcePath)).toEqual({
            engine: "postgres",
            storeId: facts.storeId,
            namespace: facts.namespace,
          });
          expect(await verifyMatchedPostgresBackup(directory, "exact", facts)).toEqual(manifest);
          const reservation: UpdateRecoveryRecord = {
            runId,
            transactionId: randomUUID(),
            revision: 0,
            claimId: randomUUID(),
            claimKind: "initial",
            handoff: null,
            source: { stateDir: state.stateDir, configPath: state.configPath },
            from: {
              root: state.root,
              nodePath: process.execPath,
              version: "2026.10.9",
              buildId: "old",
            },
            to: {
              root: state.root,
              nodePath: process.execPath,
              version: "2026.10.10",
              buildId: "candidate",
            },
            createdAtMs: 1,
            updatedAtMs: 1,
            effects: [],
            restore: null,
            verification: null,
            primaryFailure: null,
          };
          const cohort: PluginCohortRecovery = {
            runId,
            transactionId: reservation.transactionId,
            revision: 0,
            disposition: "pending",
            installKey: state.root,
            priorArtifacts: [],
            artifacts: [],
            publications: [
              {
                kind: "records",
                records: [
                  {
                    pluginId: "fixture",
                    before: { source: "npm", version: "1.0.0" },
                    after: { source: "npm", version: "2.0.0" },
                  },
                ],
              },
            ],
            settledPublications: 0,
          };
          const fence = { assertCurrent() {} };
          const pair = admitted(() =>
            beginPluginCohortRecovery(reservation, cohort, fence, { env: state.env }),
          );
          await seedInstalledPluginIndex(
            { fixture: { source: "npm", version: "2.0.0" } },
            { config, env: state.env },
          );
          expect(
            admitted(() => readConfigMachineState("plugins.installedIndex", { env: state.env })),
          ).toMatchObject({ index: { installRecords: { fixture: { version: "2.0.0" } } } });
          admitted(() => {
            writeConfigMachineState("cohort.fixture", { generation: "live" }, { env: state.env });
            writeConfigMachineState(
              "cohort.added-after-backup",
              { independent: true },
              { env: state.env },
            );
            recordUpdateRunStep(
              runId,
              { step: "after-backup", status: "completed", endedAtMs: Date.now() },
              { env: state.env },
            );
          });
          const keys = [`update.recovery.${runId}`, `update.pluginCohort.${runId}`];
          const readPairRows = async (namespace: string) =>
            (
              await client.query<{ state_key: string; value_json: string; updated_at_ms: string }>(
                `SELECT state_key,value_json,updated_at_ms::text FROM "${namespace}".config_machine_state WHERE state_key = ANY($1::text[]) ORDER BY state_key`,
                [keys],
              )
            ).rows;
          const originalPairRows = await readPairRows(facts.namespace);
          expect(originalPairRows).toHaveLength(2);
          const restore = async (name: string) => {
            const anchorPath = state.path(name, "state", "openclaw.sqlite");
            await fs.mkdir(path.dirname(anchorPath), { recursive: true, mode: 0o700 });
            opened.add(anchorPath);
            return {
              anchorPath,
              result: await preparePostgresRestoreInWorker({
                directory,
                anchorPath,
                config,
                profile: "exact",
                expectedSource: manifest.source,
                preserveUpdateHistory: true,
                pluginCohortRecovery: cohort,
                assertCurrent() {},
              }),
            };
          };
          for (const name of ["first-restore", "repeated-restore"]) {
            const restored = await restore(name);
            opened.add(restored.anchorPath);
            expect(readBackupEngineImage(restored.anchorPath, restored.anchorPath)).toEqual({
              engine: "postgres",
              storeId: facts.storeId,
              namespace: restored.result.namespace,
            });
            const options = { env: state.env, path: restored.anchorPath };
            const reopened = admitted(() =>
              getPostgresPhysicalFacts(openOpenClawStateDatabase(options).db),
            );
            expect(reopened?.namespace).toBe(restored.result.namespace);
            expect(admitted(() => loadPluginCohortRecovery(runId, options))).toEqual(pair);
            expect(
              admitted(() => readConfigMachineState("plugins.installedIndex", options)),
            ).toEqual(baselineIndex);
            expect(admitted(() => readConfigMachineState("cohort.fixture", options))).toEqual({
              generation: "baseline",
            });
            expect(
              admitted(() => readConfigMachineState("cohort.added-after-backup", options)),
            ).toBeUndefined();
            expect(
              admitted(() => getUpdateRun(runId, options))?.steps.some(
                (step) => step.step === "after-backup",
              ),
            ).toBe(true);
            expect(await readPairRows(restored.result.namespace)).toEqual(originalPairRows);
            await closeOpenClawStateDatabaseByPathAsync(restored.anchorPath);
          }
          expect(await readPairRows(facts.namespace)).toEqual(originalPairRows);
          admitted(() => deletePluginCohortRecovery(pair, fence, { env: state.env }));
          await sibling.query(`CREATE SCHEMA "${siblingNamespace}"`);
          const beforeRefusal = (
            await client.query<{ nspname: string }>(
              "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%' ORDER BY nspname",
            )
          ).rows;
          await expect(restore("missing-live-pair")).rejects.toThrow(
            "lost its live plugin cohort recovery pair",
          );
          await sibling.query(`DROP SCHEMA "${siblingNamespace}"`);
          const afterRefusal = (
            await client.query<{ nspname: string }>(
              "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%' ORDER BY nspname",
            )
          ).rows;
          expect(afterRefusal).toEqual(beforeRefusal);
          expect(
            admitted(() => readConfigMachineState("cohort.fixture", { env: state.env })),
          ).toEqual({ generation: "live" });
        } finally {
          for (const pathname of opened) {
            await closeOpenClawStateDatabaseByPathAsync(pathname);
          }
        }
      });
    });
  });
});
