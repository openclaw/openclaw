import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { expectDefined } from "@openclaw/normalization-core";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createOpenClawStateLeaseCleanup } from "../state/openclaw-state-lease-cleanup.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { hasActiveGatewayStateOwner, tryBorrowGatewayStateOwner } from "./gateway-state-owner.js";
import { readRestartSentinelSnapshotSync } from "./restart-sentinel-store.js";
import {
  detectLegacyRestartSentinel,
  migrateLegacyRestartSentinelWithCustody,
  type RestartSentinelMigrationResult,
} from "./state-migrations.restart-sentinel.js";

const sourceLeases = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.restartSentinelImport"));

/** The June updater can publish its final notice after Doctor and after Gateway readiness. */
export async function importLegacyUpdateRestartSentinel(params: {
  context: OpenClawStateWorkerContext;
  shouldRun: () => boolean;
  expectedRevision?: number;
}): Promise<RestartSentinelMigrationResult & { superseded?: boolean }> {
  const { context } = params;
  const env = context.environment;
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (path.resolve(resolveOpenClawStateSqlitePath(env)) !== context.admission.databasePath) {
    throw new Error("Restart notice import does not match its captured state database.");
  }
  const detected = detectLegacyRestartSentinel({ stateDir });
  if (!detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  let revoked = false;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      revoked ||
      !params.shouldRun() ||
      !hasActiveGatewayStateOwner(context.admission.databasePath)
    ) {
      throw new Error("Restart notice import no longer owns this Gateway generation.");
    }
  };
  assertCurrent();
  let sourceLease: ReturnType<typeof sourceLeases.reserve> | undefined;
  let custody: ReturnType<typeof tryBorrowGatewayStateOwner>;
  let maintenance: ReturnType<typeof createOpenClawDatabaseMaintenanceScope> | undefined;
  const revoke = () => {
    revoked = true;
  };
  const cleanup = createOpenClawStateLeaseCleanup({
    context,
    maintenanceScope: context.maintenanceScope,
    revoke,
    workerOwner: () => undefined,
    finish: async () => {
      await maintenance?.close();
      custody?.release();
      sourceLease?.release();
    },
  });
  return await cleanup.run(async () => {
    const lease = expectDefined(
      sourceLeases.reserve([context.admission.identity.key]),
      "Restart sentinel import lease",
    );
    sourceLease = lease;
    // Retain this Gateway before yielding; a queued import cannot borrow its successor.
    const owner = expectDefined(
      tryBorrowGatewayStateOwner(context.admission.databasePath),
      "Restart sentinel Gateway ownership",
    );
    custody = owner;
    await lease.wait();
    assertCurrent();
    const resources = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: owner.assertCurrent,
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    maintenance = resources;
    const assertOwned = () => {
      resources.assertAdmission();
      context.admission.assertCurrent();
    };
    // The restart sidecar joins this accepted work before replacing the Gateway.
    // Stable custody also preserves fs-safe's portable no-replace claim path.
    return await resources.run(async () => {
      const expectedRevision = runOpenClawStateWriteTransaction(
        ({ db }) => {
          assertOwned();
          return readRestartSentinelSnapshotSync(db).revision;
        },
        { env },
      );
      if (params.expectedRevision !== undefined && params.expectedRevision !== expectedRevision) {
        return { changes: [], warnings: [], superseded: true };
      }
      const stateRoot = await root(stateDir, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      assertOwned();
      return await migrateLegacyRestartSentinelWithCustody({
        detected,
        stateRoot,
        stateDir,
        env,
        assertCurrent: assertOwned,
        expectedRevision,
        updatesOnly: true,
      });
    });
  }, revoke);
}
