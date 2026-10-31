import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/capability-provider.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import * as support from "./service.test-support.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

type Service = ReturnType<typeof support.createService>;

function createRequest(
  service: Service,
  idempotencyKey: string,
  controller?: AbortController,
  executionMode?: "worker-turn",
) {
  return service.createWithRequest({
    profileId: "development",
    idempotencyKey,
    signal: controller?.signal,
    executionMode,
  });
}

function trackSettlement<T>(operation: Promise<T>) {
  const tracked = {
    settled: false,
    promise: operation.finally(() => {
      tracked.settled = true;
    }),
  };
  return tracked;
}

function captureRequest(...args: Parameters<typeof createRequest>) {
  return trackSettlement(createRequest(...args).catch((error: unknown) => error));
}

async function waitForEntry(entry: Promise<unknown>, operation: Promise<unknown>, phase: string) {
  await Promise.race([
    entry,
    operation.then((result) => {
      throw new Error(`Operation ended before ${phase}`, { cause: result });
    }),
  ]);
}

function createEnrollingProvider(overrides: Parameters<typeof support.createProvider>[0]) {
  return support.createProvider({
    supportedExecutionModes: ["worker-turn"],
    requiresNodeEnrollment: true,
    provisionBeforeInstallation: true,
    ...overrides,
  });
}

function observeDestroyIntent(environmentId: string) {
  const committed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (
      "all" in change &&
      change.scope === "worker-environments" &&
      support.testState.store
        .list()
        .some((row) => row.environmentId === environmentId && row.destroyRequestedAtMs !== null)
    ) {
      committed.resolve();
    }
  });
  return { committed: committed.promise, unsubscribe };
}

function createRuntimeManager(
  transfer: ReturnType<typeof createWorkerBootstrapArtifactTransferService>,
) {
  support.testState.config.gateway = {
    publicOrigin: "https://gateway.example.test",
    auth: { mode: "token", token: "test-gateway-token" },
  };
  return createWorkerNodeEnrollmentManager({
    store: support.testState.store,
    getConfig: () => support.testState.config,
    resolveAvailability: async () => ({ available: false }),
    prepareArtifact: async () => ({
      tarballPath: "/gateway/cache/node-runtime.tgz",
      tarballSha256: "c".repeat(64),
      tarballBytes: 1,
      openclawVersion: "2026.8.1",
      buildId: "gateway-source-build",
      enabledPluginIds: [],
    }),
    transfer,
  });
}

describe("worker provisioning cancellation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["bootstrapping", "ready"] as const)(
    "cancels persisted SSH bootstrap from %s while retaining its child and lease cleanup",
    async (state) => {
      let record = await support.seedBootstrapping(`worker-persisted-bootstrap-stop-${state}`);
      if (state !== "bootstrapping") {
        record = await support.testState.store.transition({
          environmentId: record.environmentId,
          from: record.state,
          to: "ready",
          patch: support.readyPatch(record.environmentId, {
            ...support.BOOTSTRAP_RECEIPT,
            bundleHash: "b".repeat(64),
          }),
        });
      }
      const entered = createDeferredCore();
      const childClosed = createDeferredCore();
      const controller = new AbortController();
      const events: string[] = [];
      let bootstrapSignal: AbortSignal | undefined;
      support.testState.bootstrapWorker = vi.fn(async ({ signal }) => {
        bootstrapSignal = signal;
        events.push("bootstrap");
        entered.resolve();
        await childClosed.promise;
        events.push("child-closed");
        signal?.throwIfAborted();
        return support.BOOTSTRAP_RECEIPT;
      });
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const service = support.createService(support.createProvider({ destroy }));
      const uninstall = service.installReconcileEnvironmentGuard(async (_environmentId, core) => {
        await core(controller.signal);
      });
      const recoveryState = trackSettlement(service.reconcileEnvironment(record.environmentId));
      const recovery = recoveryState.promise;
      let teardown: ReturnType<typeof service.destroy> | undefined;
      const stopIntent = observeDestroyIntent(record.environmentId);
      try {
        await waitForEntry(entered.promise, recovery, "bootstrap");
        if (state !== "bootstrapping") {
          expect(support.testState.store.get(record.environmentId)?.ownerEpoch).toBeGreaterThan(
            record.ownerEpoch,
          );
        }
        controller.abort(new DOMException("Stop persisted bootstrap", "AbortError"));
        teardown = service.destroy(record.environmentId);
        await stopIntent.committed;
        expect(bootstrapSignal?.aborted).toBe(true);
        expect(recoveryState.settled).toBe(false);
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toEqual(
          expect.any(Number),
        );
      } finally {
        stopIntent.unsubscribe();
        childClosed.resolve();
        await Promise.allSettled([recovery, teardown]);
        await uninstall();
      }
      expect(events).toEqual(["bootstrap", "child-closed", "destroy"]);
      expect(destroy).toHaveBeenCalledOnce();
      // Explicit Stop owns the first durable intent; bootstrap failure cannot replace it.
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: record.leaseId,
        teardownTerminalState: "destroyed",
      });
    },
  );

  it.each(["prepared", "pending"] as const)(
    "revokes a %s runtime grant without releasing its provider before settlement",
    async (phase) => {
      const entered = createDeferredCore();
      const grantReleased = createDeferredCore();
      const childExited = createDeferredCore();
      const controller = new AbortController();
      const runtimeController = new AbortController();
      const runtime = {
        nodeBootstrap: support.NODE_BOOTSTRAP,
        workerBundle: {
          ...support.NODE_BOOTSTRAP,
          packageRelativePath: `worker-artifacts/${support.NODE_BOOTSTRAP.sha256}.tgz`,
        },
        signal: runtimeController.signal,
      };
      const closeNodeRuntime = vi.fn(() => runtimeController.abort());
      const prepareNodeEnrollment = vi.fn();
      const destroy = vi.fn(async () => {});
      let operationSignal: AbortSignal | undefined;
      const service = support.createService(
        createEnrollingProvider({
          provision: async (_profile, _operationId, options) => {
            await options!.prepareNodeRuntime!();
            entered.resolve();
            await childExited.promise;
            options?.signal?.throwIfAborted();
            throw new Error("Canceled runtime preparation unexpectedly completed");
          },
          destroy,
        }),
        {
          prepareNodeRuntime: async (_record, _bundle, signal) => {
            operationSignal = signal;
            if (phase === "pending") {
              entered.resolve();
              await grantReleased.promise;
            }
            return runtime;
          },
          closeNodeRuntime,
          prepareNodeEnrollment,
        },
      );
      const creationState = captureRequest(
        service,
        `runtime-stop-${phase}`,
        controller,
        "worker-turn",
      );
      const creation = creationState.promise;
      await entered.promise;
      controller.abort(new DOMException("Stop runtime preparation", "AbortError"));
      const teardown = service.destroy(support.testState.store.list()[0]!.environmentId);
      try {
        await setImmediate();
        expect(operationSignal?.aborted).toBe(true);
        expect(creationState.settled).toBe(false);
        expect(closeNodeRuntime).toHaveBeenCalledTimes(phase === "prepared" ? 1 : 0);
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        grantReleased.resolve();
        childExited.resolve();
        await creation;
        await teardown;
      }
      expect(await creation).toMatchObject({ name: "AbortError" });
      expect(closeNodeRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
      expect(prepareNodeEnrollment).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["late-success", "profile-error", "cleanup-complete"] as const)(
    "retains allocation cleanup after cancellation with a %s provider result",
    async (result) => {
      const started = createDeferredCore();
      const childClosed = createDeferredCore();
      const events: string[] = [];
      let providerSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const reason = new Error("cloud worker stopped");
      const provider = support.createProvider({
        provision: async (_profile, _operationId, options) => {
          providerSignal = options?.signal;
          providerSignal?.addEventListener("abort", () => events.push("abort"), { once: true });
          events.push("provision");
          started.resolve();
          await childClosed.promise;
          events.push("child-closed");
          if (result === "profile-error") {
            throw new WorkerProviderError("late provider rejection");
          }
          if (result === "cleanup-complete") {
            throw WorkerProviderError.cleanupComplete(
              "lease-cancelled",
              new Error("provider setup failed before cleanup"),
            );
          }
          return { leaseId: "lease-cancelled", sharedHost: false, ssh: support.SSH_ENDPOINT };
        },
        resolveAllocation: async () => {
          events.push("resolve");
          return { leaseId: "lease-cancelled", sharedHost: false };
        },
        destroy: async ({ leaseId }) => {
          expect(leaseId).toBe("lease-cancelled");
          events.push("destroy");
        },
      });
      const service = support.createService(provider);
      const creation = createRequest(service, "cancelled-provision", controller).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await started.promise;
      const record = support.testState.store.list()[0]!;
      let teardown: ReturnType<typeof service.destroy> | undefined;
      const stopIntent = observeDestroyIntent(record.environmentId);
      try {
        controller.abort(reason);
        teardown = service.destroy(record.environmentId);
        await stopIntent.committed;
        expect(providerSignal?.aborted).toBe(true);
        expect(support.testState.store.get(record.environmentId)).toMatchObject({
          state: "provisioning",
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(events).toEqual(["provision", "abort"]);
        expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      } finally {
        stopIntent.unsubscribe();
        childClosed.resolve();
        await creation;
        await teardown;
      }
      expect(await creation).toMatchObject({ ok: false });
      expect(events.indexOf("destroy")).toBeGreaterThan(events.indexOf("child-closed"));
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-cancelled",
      });
    },
  );

  it.each(["node bundle", "fresh npm"] as const)(
    "cancels %s preparation before allocation while shutdown retains its producer",
    async (kind) => {
      const node = kind === "node bundle";
      const preparing = createDeferredCore();
      const prepared = createDeferredCore();
      const controller = new AbortController();
      const events: string[] = [];
      if (!node) {
        support.getDevelopmentProfile().install = "npm";
      }
      support.testState.prepareInstallation = vi.fn(async () => {
        events.push("bundle-started");
        preparing.resolve();
        await prepared.promise;
        events.push("bundle-settled");
        return node ? support.BUNDLE_ARTIFACT : support.NPM_ARTIFACT;
      });
      const provision = vi.fn(async () => {
        events.push("allocated");
        if (node) {
          throw new Error("Cancelled runtime preparation unexpectedly completed");
        }
        return { leaseId: "lease-unexpected", sharedHost: false, ssh: support.SSH_ENDPOINT };
      });
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const transfer = createWorkerBootstrapArtifactTransferService();
      const grant = vi.spyOn(transfer, "prepare");
      const manager = node ? createRuntimeManager(transfer) : undefined;
      const service = support.createService(
        (node ? createEnrollingProvider : support.createProvider)({ provision, destroy }),
        manager
          ? {
              prepareNodeBootstrap: manager.prepare,
              prepareNodeRuntime: manager.prepareRuntime,
              closeNodeRuntime: manager.closeRuntime,
              prepareNodeEnrollment: manager.begin,
              closeNodeEnrollment: manager.close,
              stopNodeEnrollmentWaits: manager.stop,
            }
          : {},
      );
      const creationState = trackSettlement(
        createRequest(
          service,
          `cancelled-preparation-${kind}`,
          controller,
          node ? "worker-turn" : undefined,
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      const creation = creationState.promise;
      let teardown: ReturnType<typeof service.destroy> | undefined;
      let shutdown: ReturnType<typeof trackSettlement<void>> | undefined;
      try {
        await waitForEntry(preparing.promise, creation, "installation preparation");
        controller.abort(
          node
            ? new DOMException("Stop installation preparation", "AbortError")
            : new Error("cloud worker stopped"),
        );
        teardown = service.destroy(support.testState.store.list()[0]!.environmentId);
        await support.waitForFast(() => expect(creationState.settled).toBe(true));
        await expect(teardown).resolves.toMatchObject({ state: "failed" });
        expect(events).toEqual(["bundle-started"]);
        expect(destroy).not.toHaveBeenCalled();
        expect(grant).not.toHaveBeenCalled();
        shutdown = trackSettlement(service.stop());
        await setImmediate();
        expect(shutdown?.settled).toBe(false);
        expect(provision).not.toHaveBeenCalled();
      } finally {
        prepared.resolve();
        await Promise.allSettled([creation, teardown, shutdown?.promise]);
        manager?.stop();
        grant.mockRestore();
      }
      expect(await creation).toMatchObject(
        node ? { ok: false, error: { name: "AbortError" } } : { ok: false },
      );
      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(shutdown?.settled).toBe(true);
      expect(events).toEqual(["bundle-started", "bundle-settled"]);
    },
  );

  it("cleans an adopted replay lease while cancelled npm preparation is still running", async () => {
    const preparing = createDeferredCore();
    const prepared = createDeferredCore();
    const controller = new AbortController();
    support.getDevelopmentProfile().install = "npm";
    let replay = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      if (replay) {
        preparing.resolve();
        await prepared.promise;
      }
      return support.NPM_ARTIFACT;
    });
    const events: string[] = [];
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const service = support.createService(
      support.createProvider({
        provision: async () => {
          events.push("provision");
          if (!replay) {
            throw new Error("reply lost after allocation");
          }
          return { leaseId: "lease-replayed", sharedHost: false, ssh: support.SSH_ENDPOINT };
        },
        destroy,
      }),
    );
    await expect(createRequest(service, "replay-preparation-stop")).rejects.toMatchObject({
      code: "provider_failure",
    });
    replay = true;
    const creationState = captureRequest(service, "replay-preparation-stop", controller);
    const creation = creationState.promise;
    await waitForEntry(preparing.promise, creation, "replay installation preparation");
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "bootstrapping",
      leaseId: "lease-replayed",
    });
    controller.abort(new DOMException("Stop replay packaging", "AbortError"));
    let shutdown: ReturnType<typeof trackSettlement<void>> | undefined;
    try {
      await support.waitForFast(() => expect(creationState.settled).toBe(true));
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "lease-replayed",
        profile: { region: "test" },
        signal: expect.any(AbortSignal),
      });
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "destroyed",
        leaseId: "lease-replayed",
        teardownTerminalState: "destroyed",
      });
      shutdown = trackSettlement(service.stop());
      await setImmediate();
      expect(shutdown?.settled).toBe(false);
    } finally {
      prepared.resolve();
      await Promise.allSettled([creation, shutdown?.promise]);
    }
    expect(events).toEqual(["provision", "provision", "destroy"]);
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });
  it("retains cancellation after the caller timeout until the real provider exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = createDeferredCore();
    const exited = createDeferredCore();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async (_profile, _operation, options) => {
        signal = options?.signal;
        entered.resolve();
        await exited.promise;
        signal?.throwIfAborted();
        return { leaseId: "lease-1", sharedHost: false, ssh: support.SSH_ENDPOINT };
      },
      destroy,
    });
    const service = support.createService(provider, { providerCallTimeoutMs: 20 });
    const creation = createRequest(service, "timeout-cancel", controller).catch(
      (error: unknown) => error,
    );
    let stopIntent: ReturnType<typeof observeDestroyIntent> | undefined;
    let teardownResult: Promise<unknown> | undefined;
    try {
      await waitForEntry(entered.promise, creation, "provider entry");
      await vi.advanceTimersByTimeAsync(20);
      expect(await creation).toMatchObject({ code: "provider_failure" });
      const record = support.testState.store.list()[0]!;
      stopIntent = observeDestroyIntent(record.environmentId);
      controller.abort(new Error("Stop after provider timeout"));
      teardownResult = service.destroy(record.environmentId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        stopIntent.committed,
        teardownResult.then((result) => {
          throw new Error("Teardown ended before cancellation intent committed", { cause: result });
        }),
      ]);
      expect(signal?.aborted).toBe(true);
      expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toBe(
        support.testState.nowMs,
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      stopIntent?.unsubscribe();
      exited.resolve();
      await Promise.all([creation, teardownResult]);
    }
    expect(await teardownResult).toMatchObject({ value: { state: "destroyed" } });
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.list()[0]?.state).toBe("destroyed");
  });

  it("cancels the allocated node installer and joins it before destroying the lease", async () => {
    const entered = createDeferredCore();
    const installerClosed = createDeferredCore();
    const controller = new AbortController();
    let installerSignal: AbortSignal | undefined;
    const events: string[] = [];
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const service = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provision: async () => ({
          leaseId: "lease-node-install",
          node: { deviceId: "device-install" },
          sharedHost: false,
        }),
        destroy,
      }),
      {
        ensureNodeWorkerBundle: async ({ signal }) => {
          installerSignal = signal;
          entered.resolve();
          await installerClosed.promise;
          events.push("installer-closed");
          signal?.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        },
      },
    );
    const creationState = captureRequest(service, "node-install-stop", controller, "worker-turn");
    const creation = creationState.promise;
    await waitForEntry(entered.promise, creation, "node installer");
    controller.abort(new DOMException("Stop node installation", "AbortError"));
    try {
      expect(installerSignal?.aborted).toBe(true);
      expect(creationState.settled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      installerClosed.resolve();
      await creation;
    }
    expect(events).toEqual(["installer-closed", "destroy"]);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "destroyed",
      leaseId: "lease-node-install",
      teardownTerminalState: "destroyed",
    });
  });
  it("closes only the cancelled enrollment while preserving provider cleanup", async () => {
    const waiting = createDeferredCore();
    const controller = new AbortController();
    const enrollmentController = new AbortController();
    const enrollmentClosed = new Error("enrollment closed");
    const enrollment = {
      mode: "connect" as const,
      setupCode: "setup-code",
      setupId: "setup-id",
      openclawVersion: "2026.8.1",
      nodeBootstrap: support.NODE_BOOTSTRAP,
      displayName: "fixture",
      signal: enrollmentController.signal,
      waitForDeviceId: async () => {
        waiting.resolve();
        return await new Promise<string>((_resolve, reject) => {
          enrollmentController.signal.addEventListener("abort", () => reject(enrollmentClosed), {
            once: true,
          });
        });
      },
    };
    const destroy = vi.fn(async () => {});
    const closeNodeEnrollment = vi.fn(() => enrollmentController.abort(enrollmentClosed));
    const service = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        provision: async (_profile, _operation, options) => {
          const prepared = await options!.beginNodeEnrollment!();
          await prepared.waitForDeviceId();
          throw new Error("cancelled enrollment unexpectedly completed");
        },
        destroy,
      }),
      { prepareNodeEnrollment: async () => enrollment, closeNodeEnrollment },
    );
    const creation = service
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "enrollment-cancel",
        executionMode: "worker-turn",
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await waiting.promise;
    controller.abort(new Error("Stop enrollment"));
    await creation;
    await service.destroy(support.testState.store.list()[0]!.environmentId);
    expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(enrollment);
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });
});
