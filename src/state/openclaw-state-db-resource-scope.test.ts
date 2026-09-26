import { expect, it, vi } from "vitest";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";

it("keeps resource custody unprivileged and preserves inherited owner validity", async () => {
  const runtime = createOpenClawDatabaseMaintenanceScope();
  const nestedRuntime = runtime.run(() => createOpenClawDatabaseMaintenanceScope());
  expect(runtime.ownsSchemaMaintenance).toBe(false);
  expect(nestedRuntime.ownsSchemaMaintenance).toBe(false);
  await nestedRuntime.close();
  await runtime.close();

  let current = true;
  const lost = new Error("Maintenance owner is no longer current");
  const assertOwnerCurrent = vi.fn(() => {
    if (!current) {
      throw lost;
    }
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope({ assertOwnerCurrent });
  const nested = maintenance.run(() => createOpenClawDatabaseMaintenanceScope());
  expect(nested.ownsSchemaMaintenance).toBe(false);
  nested.assertAdmission();
  expect(assertOwnerCurrent).toHaveBeenCalled();
  current = false;
  expect(() => nested.assertAdmission()).toThrow(lost);
  current = true;
  await maintenance.close();
  expect(() => nested.assertAdmission()).toThrow("Database maintenance resource scope is closed");
  await nested.close();
});

it("keeps nested authority reads in their resource scope without admitting effects or revoked work", async () => {
  let revoked = false;
  let childRevoked = false;
  let nestedEffect = false;
  const parent = createOpenClawDatabaseMaintenanceScope({
    assertOwnerCurrent: () => {
      const current = getOpenClawDatabaseMaintenanceScope();
      current?.assertReadAdmission();
      if (nestedEffect) {
        current?.assertAdmission();
      }
      if (revoked) {
        throw new Error("requester revoked");
      }
    },
  });
  const child = parent.run(() =>
    createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: () => {
        if (childRevoked) {
          throw new Error("child revoked");
        }
      },
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
