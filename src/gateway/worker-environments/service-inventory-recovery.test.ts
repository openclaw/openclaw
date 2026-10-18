import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as support from "./service.test-support.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { createWorkerEnvironmentStore } from "./store.js";

describe("worker inventory read-admission recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("resumes reconciliation after a sealed database reopens, but keeps shutdown final", async () => {
    const record = await support.seedReady("recover-after-seal");
    let sharedHost = false;
    const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost }));
    const service = support.createService(support.createProvider({ inspect }));
    await service.ready();
    await service.reconcileOnce();
    const { store, stateDb } = support.testState;
    const observer = await createWorkerEnvironmentStore({ database: stateDb });
    const originalAdmission = captureOpenClawStateDatabaseReadAdmission(stateDb.path);
    const originalVersion = store.inventoryVersion();
    const revoked = vi.fn();
    const unsubscribe = observer.onCredentialRevoked(revoked);
    const entered = createDeferred();
    const release = createDeferred();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        if (identity?.key === originalAdmission.identity.key) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const closing = closeOpenClawStateDatabaseByPathAsync(stateDb.path);
    try {
      await entered.promise;
      expect(originalAdmission.assertCurrent).toThrow(/read admission is closed/);
      await expect(service.reconcileOnce(record.environmentId)).rejects.toThrow();
    } finally {
      release.resolve();
      unregister();
      await closing;
    }

    support.testState.stateDb = openOpenClawStateDatabase({ path: stateDb.path });
    sharedHost = true;
    inspect.mockClear();
    await service.reconcileOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(store.get(record.environmentId)?.sharedHost).toBe(true);
    expect(store.inventoryVersion()).toBeGreaterThan(originalVersion);
    expect(originalAdmission.assertCurrent).toThrow(/read admission changed/);
    expect(() => observer.list()).toThrow(WorkerEnvironmentInventoryClosedError);

    await store.revokeEnvironmentCredential(record.environmentId, {
      fenceWorkspaceTransfers: true,
    });
    expect(revoked).toHaveBeenCalledWith(record.environmentId);
    unsubscribe();
    await service.stop();
    await closeOpenClawStateDatabaseAsync();
    support.testState.stateDb = openOpenClawStateDatabase({ path: stateDb.path });
    await expect(store.ready()).rejects.toBeInstanceOf(WorkerEnvironmentInventoryClosedError);
    await expect(observer.ready()).rejects.toBeInstanceOf(WorkerEnvironmentInventoryClosedError);
    expect(() => store.list()).toThrow(WorkerEnvironmentInventoryClosedError);
  });
});
