import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { prepareCandidateAuthorityRuntime } from "../../cli/update-cli/update-command-candidate-authority.test-support.js";
import { withUpdateDatabaseEngine } from "../../cli/update-cli/update-command-database-engine.js";
import { withUpdateCommandExecutor } from "../../cli/update-cli/update-command-executor.js";
import {
  finishParams,
  updateResult,
} from "../../cli/update-cli/update-command-maintenance-fixtures.test-support.js";
import { migratedFinalizeFixtureEntrypoint } from "../../cli/update-cli/update-command-migrated-fixture-entrypoint.test-support.js";
import { continueMigratedUpdateInFreshProcess } from "../../cli/update-cli/update-command-migrated.js";
import { UpdateCommandFailure } from "../../cli/update-cli/update-command-result.js";
import { withUpdateCommandTerminalResult } from "../../cli/update-cli/update-command-terminal.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as childCommands from "../../process/exec-runner.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { runtimeProcessEntrypoints } from "../runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { adoptUpdateRun, createUpdateRun } from "../update-run-ledger.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const runtime = createFixtureLifetime();

describe.skipIf(!connection)("migrated PostgreSQL update finalization", () => {
  let candidateRoot: string;
  beforeAll(async () => {
    const candidate = await runtime.run(() =>
      prepareCandidateAuthorityRuntime(runtime.createTempDir("postgres-finalizer-runtime-")),
    );
    candidateRoot = fileURLToPath(new URL("../../", candidate.worker));
  });
  afterAll(() => runtime.cleanup());

  it("selects configured storage in the fresh worker before adopting and completing its run", async () => {
    const prefix = `finalize_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await withOpenClawTestState({ label: "postgres-finalizer" }, async (state) => {
        const env = {
          ...state.env,
          NODE_ENV: "production",
          NODE_OPTIONS: undefined,
          BUN_OPTIONS: undefined,
          OPENCLAW_TEST_CLI_DSN: connection!,
        };
        const config: OpenClawConfig = {
          database: {
            engine: "sqlite",
            families: { state: { engine: "postgres" } },
            postgres: {
              connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_CLI_DSN" },
              schemaPrefix: prefix,
            },
          },
          plugins: { enabled: false },
        };
        await state.writeConfig(config);
        await withUpdateDatabaseEngine(env, async () => {
          try {
            const created = withEngineStoreAdmission(() => {
              openOpenClawStateDatabase({ env });
              const run = createUpdateRun({ trigger: "cli" }, { env });
              adoptUpdateRun(run.runId, { env });
              return run;
            });
            const run = { runId: created.runId, env };
            // The real child gets only config/environment, never the parent's ALS
            // engine selection or the conformance worker's environment-data fallback.
            const nativeCommand = childCommands.runUtf8CommandBuffersWithTimeout;
            using _ = vi
              .spyOn(childCommands, "runUtf8CommandBuffersWithTimeout")
              .mockImplementation((argv, options) =>
                nativeCommand(
                  [
                    process.execPath,
                    ...resolveRuntimeWorkerArgv(
                      resolveRuntimeWorkerUrl(migratedFinalizeFixtureEntrypoint),
                    ),
                    JSON.stringify({
                      readOnlyEntrypoint: runtimeProcessEntrypoints.sqliteReadOnly,
                      serviceAbsent: true,
                    }),
                    ...argv.slice(2),
                  ],
                  options,
                ),
              );
            let finalized:
              | Awaited<ReturnType<typeof continueMigratedUpdateInFreshProcess>>
              | undefined;
            const completion = withUpdateCommandTerminalResult(
              (registerRun) =>
                withUpdateCommandExecutor(run.runId, async (executor) => {
                  const executorFence = await executor.enter(candidateRoot);
                  const scopedRun = { ...run, executorFence };
                  registerRun(scopedRun);
                  finalized = await continueMigratedUpdateInFreshProcess(
                    finishParams({
                      root: candidateRoot,
                      result: updateResult({
                        status: "error",
                        reason: "synthetic-core-verification-failed",
                        mode: "git",
                        root: candidateRoot,
                      }),
                      configSnapshot: createTestConfigSnapshot(config, config, state.configPath),
                      shouldRestart: false,
                      rollbackBlockedReason: "state-migrated-no-rollback",
                      opts: { json: true, restart: false, run: scopedRun },
                    }),
                    [],
                  );
                  if (finalized.preparedFailure) {
                    throw finalized.preparedFailure;
                  }
                  return finalized;
                }),
              { json: true },
            );
            await expect(completion).rejects.toBeInstanceOf(UpdateCommandFailure);
            expect(finalized).toMatchObject({
              result: { status: "error", runId: run.runId, reason: "state-migrated-no-rollback" },
              exitCode: 1,
              candidateStartAttempted: false,
            });
            using anchor = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), {
              readOnly: true,
            });
            expect(
              anchor
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all(),
            ).toEqual([{ name: "openclaw_engine_anchor" }]);
            const identity = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
            const schema = identity?.schema;
            assert(typeof schema === "string", "The PostgreSQL anchor must identify its schema");
            await withPostgresConnection(
              { connection: connection!, schemaPrefix: prefix },
              async (client) => {
                const rows = await client.query(
                  `SELECT run_id, status, phase FROM "${schema.replaceAll('"', '""')}".update_runs WHERE run_id = $1`,
                  [run.runId],
                );
                expect(rows.rows).toEqual([
                  { run_id: run.runId, status: "failed", phase: "finished" },
                ]);
              },
            );
          } finally {
            await closeOpenClawStateDatabaseAsync();
          }
        });
      });
    } finally {
      await withPostgresConnection({ connection: connection!, schemaPrefix: prefix }, (client) =>
        dropPostgresTestSchemas(client, prefix),
      );
    }
  });
});
