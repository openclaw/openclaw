import { expect, it, vi } from "vitest";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

it("distinguishes runtime custody and preserves inherited schema maintenance", async () => {
  const runtime = createOpenClawDatabaseMaintenanceScope();
  const nestedRuntime = runtime.run(() => createOpenClawDatabaseMaintenanceScope());
  expect(runtime.ownsSchemaMaintenance).toBe(false);
  expect(nestedRuntime.ownsSchemaMaintenance).toBe(false);
  await nestedRuntime.close();
  await runtime.close();

  const delegate = vi.fn(() => undefined);
  const maintenance = createOpenClawDatabaseMaintenanceScope(delegate);
  const nested = maintenance.run(() => createOpenClawDatabaseMaintenanceScope());
  const request = { databasePath: "/synthetic/state.sqlite", actorId: "synthetic" };
  expect(nested.ownsSchemaMaintenance).toBe(true);
  nested.createSchemaFenceDelegate(request);
  expect(delegate).toHaveBeenCalledExactlyOnceWith(request);
  await maintenance.close();
  expect(() => nested.createSchemaFenceDelegate(request)).toThrow(
    "Database maintenance resource scope is closed",
  );
  expect(delegate).toHaveBeenCalledOnce();
  await nested.close();
});
