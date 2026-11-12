import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { updateExecutorEntrypoints } from "../../cli/cli-entrypoint.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { resolvePathViaExistingAncestorSync } from "../boundary-path.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { readGatewayOwnerLease, readGatewayOwnerLeaseAsync } from "../gateway-owner-lease.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import {
  assertForegroundUpdateOrigin,
  cancelManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
} from "../update-managed-service-handoff.js";
import { createUpdateRun, getUpdateRunAsync } from "../update-run-ledger.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const updateOwnerPgInput: unknown = getEnvironmentData(
  "openclaw.test.state.conformance.connection",
);
const updateOwnerPgConnection =
  typeof updateOwnerPgInput === "string" ? updateOwnerPgInput : undefined;

it.skipIf(!updateOwnerPgConnection)(
  "verifies a native PostgreSQL foreground owner on the Gateway thread without admitting ordinary SQL",
  async () => {
    expect(threadId).toBe(0);
    installDatabaseProcessRole("gateway");
    expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
    const schemaPrefix = `update_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const database = {
      engine: "postgres" as const,
      postgres: { connection: updateOwnerPgConnection!, schemaPrefix },
    };
    await withPostgresConnection(database.postgres, async (client) => {
      try {
        await withOpenClawTestState({ label: "postgres-update-owner" }, async (state) =>
          withEnv({ TMPDIR: state.root }, async () => {
            state.env.TMPDIR = state.root;
            // Cold selection must retain ordinary include and env-secret resolution.
            state.env.UPDATE_OWNER_POSTGRES_CONNECTION = updateOwnerPgConnection;
            await fs.writeFile(
              path.join(path.dirname(state.configPath), "database.json5"),
              JSON.stringify({
                database: {
                  ...database,
                  postgres: {
                    ...database.postgres,
                    connection: "${UPDATE_OWNER_POSTGRES_CONNECTION}",
                  },
                },
              }),
            );
            await state.writeConfig({ $include: "./database.json5" });
            installDatabaseEngineSelection({
              effectiveEngines: resolveDatabaseFamilyEngines({ database }),
              postgres: database.postgres,
            });
            // Only boot admission is synchronous. The retained real PG connection
            // must remain unusable for ordinary main-thread SQL after this returns.
            const opened = withEngineStoreAdmission(() =>
              openOpenClawStateDatabase({ env: state.env }),
            );
            expect(getPostgresPhysicalFacts(opened.db)?.namespace).toMatch(
              new RegExp(`^${schemaPrefix}_`),
            );
            expect(() => opened.db.prepare("SELECT 1").get()).toThrow("must run in a worker");
            const port = await reserveTestPortListener({
              offsets: [0],
              createListener: () => createServer((socket) => socket.destroy()),
            });
            let lock: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined;
            try {
              // Real native lock + PostgreSQL lease acquisition; no row injection.
              lock = await acquireGatewayLock({
                env: state.env,
                allowInTests: true,
                port: port.claim.port,
                listenerMode: "foreground",
                supervisor: null,
              });
              expect(lock).not.toBeNull();
              const owner = await readGatewayOwnerLeaseAsync({ env: state.env });
              expect(owner).toMatchObject({
                pid: process.pid,
                port: port.claim.port,
                mode: "foreground",
                state: "live",
              });
              if (!owner || owner.startedAt === null) {
                throw new Error("Native Gateway owner requires a verified process start identity");
              }
              const origin = {
                owner: owner.owner,
                pid: process.pid,
                host: owner.host,
                startedAt: owner.startedAt,
                port: port.claim.port,
                stateDatabasePath: resolvePathViaExistingAncestorSync(
                  resolveOpenClawStateSqlitePath(state.env),
                ),
                configPath: resolvePathViaExistingAncestorSync(state.configPath),
              };
              await expect(
                assertForegroundUpdateOrigin(origin, false, state.env),
              ).resolves.toBeUndefined();
              await expect(
                assertForegroundUpdateOrigin(
                  { ...origin, owner: "another-owner" },
                  false,
                  state.env,
                ),
              ).rejects.toThrow("Foreground Gateway owner or paths changed");
              expect(() => readGatewayOwnerLease({ env: state.env, current: true })).toThrow(
                "must run in a worker",
              );
              const installRoot = state.path("handoff-install");
              await fs.mkdir(path.join(installRoot, "dist", "cli"), { recursive: true });
              await fs.writeFile(
                path.join(installRoot, "package.json"),
                JSON.stringify({ name: "openclaw", type: "module", version: "1.0.0" }),
              );
              const cliEntry = path.join(installRoot, "openclaw.mjs");
              await fs.writeFile(cliEntry, "");
              // This is an installed-entry adapter to the REAL compiled production verifier.
              // The ledger is deliberately NOT exported: pre-activation bookkeeping belongs
              // to the staged sealed runtime. No helper selection/role is injected by the test.
              await fs.writeFile(
                path.join(installRoot, "dist", "cli", "daemon-cli.js"),
                `export { assertForegroundUpdateOrigin } from ${JSON.stringify(
                  resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff).href,
                )};\n`,
              );
              // An unrouted CLI run has no Gateway notice: this listener proves
              // native ownership only; public update.run proof covers delivery.
              const run = withEngineStoreAdmission(() =>
                createUpdateRun({ trigger: "cli" }, { env: state.env }),
              );
              let handoff: Awaited<ReturnType<typeof startManagedServiceUpdateHandoff>> | undefined;
              let cancelled = false;
              try {
                // Actual native child, actual generated handoff script and sealed bundle,
                // actual PG ledger, and actual installed-runtime worker-backed origin check.
                // At F this rejects before READY with SqliteSchemaMismatchError (PG anchor).
                handoff = await startManagedServiceUpdateHandoff({
                  root: installRoot,
                  runId: run.runId,
                  env: state.env,
                  execPath: resolveTestNodeExecPath(),
                  argv1: cliEntry,
                  restartDrainTimeoutMs: 300_000,
                  foregroundOrigin: origin,
                  meta: { completionOwner: "gateway-restart" },
                });
                expect(handoff.status).toBe("started");
                if (handoff.status !== "started") {
                  throw new Error("Expected a fresh handoff helper");
                }
                const adopted = await getUpdateRunAsync(run.runId, { env: state.env });
                expect(adopted?.origin.managedHandoff?.helper.pid).toBe(handoff.pid);
                expect(adopted?.origin.managedHandoff?.parent.pid).toBe(process.pid);
                expect(adopted?.status).toBe("running");
                expect(() => assertEngineStoreExecutionAllowed()).toThrow("must run in a worker");
                expect(() => opened.db.prepare("SELECT 1").get()).toThrow("must run in a worker");
                await expect(
                  cancelManagedServiceUpdateHandoff({
                    kind: "managed-update-handoff",
                    installRoot: handoff.installRoot,
                    handoffId: handoff.handoffId,
                  }),
                ).resolves.toBe("restored-in-process");
                cancelled = true;
                await expect(
                  getUpdateRunAsync(run.runId, { env: state.env }),
                ).resolves.toMatchObject({
                  status: "skipped",
                  reason: "managed-service-handoff-cancelled",
                });
                // Original native foreground ownership remains live after cold helper cleanup.
                await expect(
                  assertForegroundUpdateOrigin(origin, false, state.env),
                ).resolves.toBeUndefined();
              } finally {
                if (!cancelled && handoff?.status === "started") {
                  await cancelManagedServiceUpdateHandoff({
                    kind: "managed-update-handoff",
                    installRoot: handoff.installRoot,
                    handoffId: handoff.handoffId,
                  });
                }
              }
            } finally {
              await runQaGatewayFixture(
                async () => {
                  await lock?.release();
                },
                port.releaseListener,
                port.claim.release,
                closeOpenClawStateDatabaseAsync,
              );
            }
          }),
        );
      } finally {
        // No handle/worker may survive namespace removal. Use the existing exact
        // prefix cleanup helper; never drop another test's or operator's schema.
        await closeOpenClawStateDatabaseAsync();
        resetDatabaseEngineSelectionForTest();
        await dropPostgresTestSchemas(client, schemaPrefix);
      }
    });
  },
);
