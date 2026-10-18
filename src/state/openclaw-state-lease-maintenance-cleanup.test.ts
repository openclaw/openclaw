import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

it("releases an admitted lease after policy retirement without admitting new effects", async () => {
  await withOpenClawTestState({ label: "lease-retired-maintenance" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const owner = acquireGatewayStateOwner({ databasePath: database.path });
    const retired = new Error("retired maintenance policy");
    let active = true;
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {
        if (!active) {
          throw retired;
        }
      },
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    let enteredNewEffect = false;
    try {
      await expect(
        scope.run(() =>
          withOpenClawStateLease(
            {
              scope: "core:test",
              key: "retired-maintenance",
              database: { scope: "shared", options: { env: state.env } },
              leaseMs: 60_000,
              waitMs: 0,
            },
            async () => {
              active = false;
              expect(() => scope.run(() => (enteredNewEffect = true))).toThrow(retired);
              throw retired;
            },
          ),
        ),
      ).rejects.toBe(retired);
      expect(enteredNewEffect).toBe(false);
      await closeOpenClawStateDatabaseAsync();
      const reader = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .get("core:test", "retired-maintenance"),
        ).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      await scope.close();
      owner.release();
    }
  });
});

it("retains lease cleanup when the shared database is replaced until the original returns", async () => {
  await withOpenClawTestState({ label: "lease-replaced-maintenance" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const owner = acquireGatewayStateOwner({ databasePath: database.path });
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    const original = `${database.path}.original`;
    let replaced = false;
    try {
      await expect(
        scope.run(() =>
          withOpenClawStateLease(
            {
              scope: "core:test",
              key: "replaced-maintenance",
              database: { scope: "shared", options: { env: state.env } },
              leaseMs: 60_000,
              waitMs: 0,
            },
            async () => {
              await closeOpenClawStateDatabaseAsync();
              fs.renameSync(database.path, original);
              fs.copyFileSync(original, database.path);
              replaced = true;
            },
          ),
        ),
      ).rejects.toThrow("cannot adopt a replacement shared database");
      fs.unlinkSync(database.path);
      fs.renameSync(original, database.path);
      replaced = false;
      await closeOpenClawStateDatabaseAsync();
      const reader = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .get("core:test", "replaced-maintenance"),
        ).toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      if (replaced) {
        fs.unlinkSync(database.path);
        fs.renameSync(original, database.path);
      }
      await scope.close();
      owner.release();
    }
  });
});
