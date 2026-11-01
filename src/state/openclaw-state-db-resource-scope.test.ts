import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope as createScope,
  getOpenClawDatabaseMaintenanceScope as currentScope,
  observeOpenClawDatabaseMaintenanceResource as observeResource,
} from "./openclaw-state-db-async-lifecycle.js";

it("keeps resource custody unprivileged and preserves inherited owner validity", async () => {
  const runtime = createScope();
  const nestedRuntime = runtime.run(createScope);
  expect(runtime.ownsSchemaMaintenance).toBe(false);
  expect(nestedRuntime.ownsSchemaMaintenance).toBe(false);
  await nestedRuntime.close();
  await runtime.close();

  let current = true;
  const lost = new Error("Maintenance owner is no longer current");
  const assertOwnerCurrent = vi.fn(() => assert(current, lost));
  const maintenance = createScope({ assertOwnerCurrent });
  const nested = maintenance.run(createScope);
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
  const maintenance = createScope();
  const resume = createDeferredCore();
  const events: string[] = [];
  const operation = maintenance.run(async () => {
    events.push("operation-started");
    await resume.promise;
    events.push("operation-settled");
  });
  const closing = maintenance.close(() => void events.push("resources-closing"));
  await Promise.resolve();
  expect(events).toEqual(["operation-started"]);

  resume.resolve();
  await Promise.all([operation, closing]);
  expect(events).toEqual(["operation-started", "operation-settled", "resources-closing"]);
});

it("keeps nested authority reads in their resource scope without admitting effects or revoked work", async () => {
  let revoked = false;
  let childRevoked = false;
  let nestedEffect: "admission" | "database" | undefined;
  const resource = {};
  const parent = createScope({
    assertOwnerCurrent: () => {
      const current = currentScope();
      current?.assertReadAdmission();
      observeResource(resource);
      if (nestedEffect === "database") {
        current?.assertDatabaseAccess("/private/fixture-secret/state.sqlite");
      } else if (nestedEffect) {
        current?.assertAdmission();
      }
      assert(!revoked, new Error("requester revoked"));
    },
  });
  const child = parent.run(() =>
    createScope({
      assertOwnerCurrent: () => assert(!childRevoked, new Error("child revoked")),
    }),
  );
  const close = vi.fn();
  try {
    child.run(() => {
      child.own(resource, "shared-handles", close);
      observeResource(resource);
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
