import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { resolvePathViaExistingAncestorSync } from "../boundary-path.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { readGatewayOwnerLease, readGatewayOwnerLeaseAsync } from "../gateway-owner-lease.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { assertForegroundUpdateOrigin } from "../update-managed-service-handoff.js";
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
        await withOpenClawTestState({ label: "postgres-update-owner" }, async (state) => {
          await state.writeConfig({ database });
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
              assertForegroundUpdateOrigin({ ...origin, owner: "another-owner" }, false, state.env),
            ).rejects.toThrow("Foreground Gateway owner or paths changed");
            expect(() => readGatewayOwnerLease({ env: state.env, current: true })).toThrow(
              "must run in a worker",
            );
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
        });
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
