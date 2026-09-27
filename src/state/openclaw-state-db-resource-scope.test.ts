import { expect, it, vi } from "vitest";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";

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

it("keeps nested authority reads in their resource scope without admitting effects or revoked work", async () => {
  let revoked = false;
  let childRevoked = false;
  let nestedEffect = false;
  const parent = createOpenClawDatabaseMaintenanceScope(undefined, () => {
    const current = getOpenClawDatabaseMaintenanceScope();
    current?.assertReadAdmission();
    if (nestedEffect) {
      current?.assertAdmission();
    }
    if (revoked) {
      throw new Error("requester revoked");
    }
  });
  const child = parent.run(() =>
    createOpenClawDatabaseMaintenanceScope(undefined, () => {
      if (childRevoked) {
        throw new Error("child revoked");
      }
    }),
  );
  const resource = {};
  const close = vi.fn();
  try {
    child.run(() => {
      child.own(resource, "shared-handles", close);
      observeOpenClawDatabaseMaintenanceResource(resource);
      child.assertAgentSchemaMigration({
        agentId: "main",
        path: "/synthetic/agent.sqlite",
        foundVersion: 1,
        supportedVersion: 2,
      });
    });
    nestedEffect = true;
    expect(() => child.run(() => child.assertAdmission())).toThrow("cannot admit a nested effect");
    nestedEffect = false;
    expect(() => child.run(() => child.assertAdmission())).not.toThrow();
    await expect(
      child.run(async () => {
        await Promise.resolve();
        childRevoked = true;
        parent.assertOwnerCurrent();
      }),
    ).rejects.toThrow("child revoked");
    childRevoked = false;
    revoked = true;
    expect(() => child.run(() => child.assertReadAdmission())).toThrow("requester revoked");
  } finally {
    await child.close();
    await parent.close();
  }
  expect(close).toHaveBeenCalledOnce();
  expect(() => child.assertReadAdmission()).toThrow("resource scope is closed");
});
