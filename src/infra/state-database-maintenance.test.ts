import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getStateDatabaseSchemaLease,
  tryAcquireGatewayStateOwner,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { withStateDatabaseSchemaMaintenanceAsync } from "./state-database-maintenance.js";

const leases: StateDatabaseSchemaLease[] = [];
const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    for (const lease of leases.splice(0).toReversed()) {
      lease.release();
    }
    cleanup();
  }),
);

function currentLease(databasePath: string): StateDatabaseSchemaLease {
  const lease = getStateDatabaseSchemaLease(databasePath);
  if (!lease) {
    throw new Error("Expected the operation's schema lease");
  }
  leases.push(lease);
  return lease;
}

it.each([false, true])(
  "joins nested schema preparation and releases after rejection=%s",
  async (reject) => {
    const databasePath = path.join(
      directories.make("async-schema-maintenance-"),
      "state",
      "openclaw.sqlite",
    );
    const failure = new Error("controlled preparation failure");
    const operation = withStateDatabaseSchemaMaintenanceAsync({ databasePath }, async () => {
      const outer = currentLease(databasePath);
      const prepared = await withStateDatabaseSchemaMaintenanceAsync({ databasePath }, async () => {
        await Promise.resolve();
        expect(getStateDatabaseSchemaLease(databasePath)).toBe(outer);
        expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
        return "prepared";
      });
      expect(getStateDatabaseSchemaLease(databasePath)).toBe(outer);
      if (reject) {
        throw failure;
      }
      return prepared;
    });
    if (reject) {
      await expect(operation).rejects.toBe(failure);
    } else {
      await expect(operation).resolves.toBe("prepared");
    }
    const successor = tryAcquireGatewayStateOwner(databasePath);
    expect(successor).not.toBeNull();
    successor?.release();
  },
);

it.each([false, true])("retains release failures with operation failure=%s", async (reject) => {
  const databasePath = path.join(
    directories.make("async-schema-cleanup-"),
    "state",
    "openclaw.sqlite",
  );
  const failure = new Error("controlled preparation failure");
  const releaseFailure = new Error("controlled schema release failure");
  const operation = withStateDatabaseSchemaMaintenanceAsync({ databasePath }, async () => {
    const lease = currentLease(databasePath);
    vi.spyOn(lease, "release").mockImplementation(() => {
      throw releaseFailure;
    });
    await Promise.resolve();
    if (reject) {
      throw failure;
    }
  });
  await expect(operation).rejects.toMatchObject(
    reject
      ? { cause: failure, errors: [failure, releaseFailure] }
      : { name: "SqliteCoordinatorError", cause: releaseFailure },
  );
});
