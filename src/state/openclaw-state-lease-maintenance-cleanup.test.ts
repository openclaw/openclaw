import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

async function withMaintenance(
  key: string,
  run: (fixture: {
    database: ReturnType<typeof openOpenClawStateDatabase>;
    scope: ReturnType<typeof createOpenClawDatabaseMaintenanceScope>;
    lease: (callback: () => Promise<void>) => Promise<void>;
  }) => Promise<void>,
  assertOwnerCurrent = () => {},
) {
  await withOpenClawTestState({ label: key }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const owner = acquireGatewayStateOwner({ databasePath: database.path });
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent,
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    const lease = (callback: () => Promise<void>) =>
      scope.run(() =>
        withOpenClawStateLease(
          {
            scope: "core:test",
            key,
            database: { scope: "shared", options: { env: state.env } },
            leaseMs: 60_000,
            waitMs: 0,
          },
          callback,
        ),
      );
    try {
      await run({ database, scope, lease });
    } finally {
      await scope.close();
      owner.release();
    }
  });
}

async function expectReleased(databasePath: string, key: string) {
  await closeOpenClawStateDatabaseAsync();
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(
      reader
        .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get("core:test", key),
    ).toBeUndefined();
  } finally {
    reader.close();
  }
}

it("releases an admitted lease after policy retirement without admitting new effects", async () => {
  const retired = new Error("retired maintenance policy");
  let active = true;
  let enteredNewEffect = false;
  await withMaintenance(
    "retired-maintenance",
    async ({ database, scope, lease }) => {
      await expect(
        lease(async () => {
          active = false;
          expect(() => scope.run(() => (enteredNewEffect = true))).toThrow(retired);
          throw retired;
        }),
      ).rejects.toBe(retired);
      expect(enteredNewEffect).toBe(false);
      await expectReleased(database.path, "retired-maintenance");
    },
    () => {
      if (!active) {
        throw retired;
      }
    },
  );
});

it("retains lease cleanup when the shared database is replaced until the original returns", async () => {
  await withMaintenance("replaced-maintenance", async ({ database, lease }) => {
    const original = `${database.path}.original`;
    let replaced = false;
    try {
      await expect(
        lease(async () => {
          await closeOpenClawStateDatabaseAsync();
          fs.renameSync(database.path, original);
          fs.copyFileSync(original, database.path);
          replaced = true;
        }),
      ).rejects.toThrow("cannot adopt a replacement shared database");
      fs.unlinkSync(database.path);
      fs.renameSync(original, database.path);
      replaced = false;
      await expectReleased(database.path, "replaced-maintenance");
    } finally {
      if (replaced) {
        fs.unlinkSync(database.path);
        fs.renameSync(original, database.path);
      }
    }
  });
});
