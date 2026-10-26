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
import { formatGatewayPendingCloseSteps } from "../restart-trace.js";
import * as support from "./service.test-support.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { createWorkerEnvironmentStore } from "./store.js";

describe("worker inventory read-admission recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("releases queued reconciliation while retaining the admitted provider mutation", async () => {
    const environment = await support.seedReady("shutdown-queued-reconcile");
    const entered = createDeferred();
    const remote = createDeferred();
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const service = support.createService(
      support.createProvider({
        inspect,
        destroy: async () => {
          entered.resolve();
          await remote.promise;
        },
      }),
    );
    const mutation = service.destroy(environment.environmentId);
    await entered.promise;
    let reconciled = false;
    const reconciliation = service
      .reconcileEnvironment(environment.environmentId)
      .catch(() => undefined)
      .then(() => {
        reconciled = true;
      });
    service.beginClose();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconciled).toBe(true);
      expect(stopped).toBe(false);
      const inventoryRead = vi.spyOn(support.testState.store, "get").mockImplementation(() => {
        throw new WorkerEnvironmentInventoryClosedError();
      });
      try {
        const pending = formatGatewayPendingCloseSteps();
        expect(pending).toContain("environment=shutdown-queued-reconcile");
        expect(pending).toContain("provider=fake");
        expect(pending).toContain("step=destroy");
      } finally {
        inventoryRead.mockRestore();
      }
    } finally {
      vi.useRealTimers();
      remote.resolve();
      await Promise.all([mutation, reconciliation, stopping]);
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(support.testState.store.get(environment.environmentId)?.state).toBe("destroyed");
  });

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
    await service.reconcileEnvironment(record.environmentId);
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
