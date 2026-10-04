import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
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
  const disposal = createDeferredCore();
  maintenance.run(() => maintenance.own({}, "shared-handles", () => disposal.promise));
  const closing = maintenance.close();
  expect(() => maintenance.run(() => {})).toThrow("resource admission is closed");
  disposal.resolve();
  await closing;
  expect(() => nested.assertAdmission()).toThrow("Database maintenance resource scope is closed");
  await nested.close();
});

it("settles accepted work before running pre-resource cleanup", async () => {
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const events: string[] = [];
  const operation = maintenance.run(async () => {
    events.push("operation-started");
    entered.resolve();
    await resume.promise;
    events.push("operation-settled");
  });
  await entered.promise;

  const closing = maintenance.close(() => {
    events.push("resources-closing");
  });
  await Promise.resolve();
  expect(events).toEqual(["operation-started"]);

  resume.resolve();
  await operation;
  await closing;
  expect(events).toEqual(["operation-started", "operation-settled", "resources-closing"]);
});

it("keeps nested authority reads in their resource scope without admitting effects or revoked work", async () => {
  let revoked = false;
  let childRevoked = false;
  let nestedEffect = false;
  const resource = {};
  const parent = createOpenClawDatabaseMaintenanceScope({
    assertOwnerCurrent: () => {
      const current = getOpenClawDatabaseMaintenanceScope();
      current?.assertReadAdmission();
      observeOpenClawDatabaseMaintenanceResource(resource);
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
