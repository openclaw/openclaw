import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

it.each(["retired", "replaced"] as const)(
  "releases the original lease after maintenance is %s",
  async (ending) => {
    await withOpenClawTestState({ label: `lease-${ending}-maintenance` }, async ({ env }) => {
      const database = openOpenClawStateDatabase({ env });
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
      const effect = vi.fn();
      const original = `${database.path}.original`;
      let replaced = false;
      const restore = () => {
        if (replaced) {
          fs.unlinkSync(database.path);
          fs.renameSync(original, database.path);
          replaced = false;
        }
      };
      try {
        const operation = scope.run(() =>
          withOpenClawStateLease(
            {
              scope: "core:test",
              key: ending,
              database: { scope: "shared", options: { env } },
              leaseMs: 60_000,
              waitMs: 0,
            },
            async () => {
              if (ending === "retired") {
                active = false;
                expect(() => scope.run(effect)).toThrow(retired);
                throw retired;
              }
              await closeOpenClawStateDatabaseAsync();
              fs.renameSync(database.path, original);
              fs.copyFileSync(original, database.path);
              replaced = true;
            },
          ),
        );
        if (ending === "retired") {
          await expect(operation).rejects.toBe(retired);
          expect(effect).not.toHaveBeenCalled();
        } else {
          await expect(operation).rejects.toThrow(
            "path no longer matches its borrowed native owner",
          );
        }
        restore();
        await closeOpenClawStateDatabaseAsync();
        const reader = new DatabaseSync(database.path, { readOnly: true });
        try {
          expect(
            reader
              .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
              .get("core:test", ending),
          ).toBeUndefined();
        } finally {
          reader.close();
        }
      } finally {
        restore();
        await scope.close();
        owner.release();
      }
    });
  },
);
