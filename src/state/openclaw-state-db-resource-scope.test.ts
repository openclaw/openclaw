import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureOpenClawDatabaseMaintenanceResource,
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { isSqliteWorkerMaintenanceAuthorityCurrent } from "./openclaw-state-maintenance-authority.js";
import { captureSqliteWorkerMaintenanceAuthority } from "./openclaw-state-maintenance-context.js";

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
  let nestedEffect: "admission" | "database" | undefined;
  const resource = {};
  const parent = createOpenClawDatabaseMaintenanceScope({
    assertOwnerCurrent: () => {
      const current = getOpenClawDatabaseMaintenanceScope();
      current?.assertReadAdmission();
      observeOpenClawDatabaseMaintenanceResource(resource);
      if (nestedEffect === "database") {
        current?.assertDatabaseAccess("/private/fixture-secret/state.sqlite");
      } else if (nestedEffect) {
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
    nestedEffect = "admission";
    expect(() => child.run(() => child.assertAdmission())).toThrow(
      /^Database maintenance authority check cannot admit a nested effect \(access=effect; caller=[\w$.]*assertAdmission[\w$. <-]{0,140}\)$/u,
    );
    nestedEffect = "database";
    expect(() => child.run(() => child.assertAdmission())).toThrow(
      /caller=[\w$. <-]*assertDatabaseAccess[\w$. <-]*\)$/u,
    );
    nestedEffect = undefined;
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

it("keeps accepted resource work independent of a transferred resource claim while draining", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const resource = {};
  scope.own(resource, "shared-handles", () => {});
  const held = captureOpenClawDatabaseMaintenanceResource(resource, scope);
  const outside = captureSqliteWorkerMaintenanceAuthority(scope)!;
  const resume = createDeferredCore();
  let accepted: typeof outside | undefined;
  const running = held.run(async () => {
    accepted = captureSqliteWorkerMaintenanceAuthority(scope);
    await resume.promise;
    scope.assertAdmission();
  });
  observeOpenClawDatabaseMaintenanceResource(resource);
  expect(held.assertCurrent).toThrow("resource owner changed");
  await expect(held.run(async () => {})).rejects.toThrow("resource owner changed");
  const closing = scope.close();
  expect(isSqliteWorkerMaintenanceAuthorityCurrent(outside)).toBe(false);
  expect(isSqliteWorkerMaintenanceAuthorityCurrent(accepted!)).toBe(true);
  resume.resolve();
  await running;
  await closing;
  expect(isSqliteWorkerMaintenanceAuthorityCurrent(accepted!)).toBe(false);
});

it("reopens a failed cleanup without reviving its frame during the next attempt", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const failure = new Error("cleanup failed");
  let fail = true;
  const retryDone = createDeferredCore();
  const cleanupFrames: NonNullable<ReturnType<typeof captureSqliteWorkerMaintenanceAuthority>>[] =
    [];
  scope.own({}, "shared-handles", () => {
    cleanupFrames.push(captureSqliteWorkerMaintenanceAuthority(scope)!);
    if (fail) {
      throw failure;
    }
    return retryDone.promise;
  });
  const captured = captureSqliteWorkerMaintenanceAuthority(scope)!;
  await expect(scope.close()).rejects.toThrow(failure);
  expect(isSqliteWorkerMaintenanceAuthorityCurrent(captured)).toBe(true);
  expect(() => scope.run(() => {})).not.toThrow();
  fail = false;
  const retry = scope.close();
  try {
    expect(cleanupFrames.map(isSqliteWorkerMaintenanceAuthorityCurrent)).toEqual([false, true]);
  } finally {
    retryDone.resolve();
    await retry;
  }
  expect(isSqliteWorkerMaintenanceAuthorityCurrent(captured)).toBe(false);
  expect(() => scope.run(() => {})).toThrow("resource scope is closed");
});
