import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import { createWorkerCredentialBroker } from "./credential-broker.js";
import { PROJECT_KEY, RECEIPT, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";

class TestWorkerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

describe("prepared worker expiry during admitted work", () => {
  const fixture = usePreparedPoolFixture();

  it.each(["enrollment", "readiness"] as const)(
    "retains capacity until cleanup and refuses late %s without aborting admitted work",
    async (boundary) => {
      const reserve = fixture.seed("admitted-reserve", { reserve: true });
      const entered = createDeferred();
      const releaseWork = createDeferred();
      const destroyEntered = createDeferred();
      const releaseDestroy = createDeferred();
      fixture.releases.push(
        () => releaseWork.resolve(),
        () => releaseDestroy.resolve(),
      );
      let operationSignal: AbortSignal | undefined;
      const prepareInstallation = async () => ({
        install: "bundle" as const,
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "f".repeat(64),
        tarballPath: path.join(fixture.root, "unused.tgz"),
      });
      const shared = {
        store: fixture.store,
        now: () => fixture.nowMs,
        prepareInstallation,
        isStopping: () => false,
        inState: (record, ...states) => states.includes(record.state),
        withLock: async (_environmentId, task) => await task(),
        serviceError: (code, message) => new TestWorkerServiceError(code, message),
        move: (record, to, patch) =>
          fixture.store.transition({
            environmentId: record.environmentId,
            from: record.state,
            expectedOwnerEpoch: record.ownerEpoch,
            to,
            patch,
          }),
      } satisfies Pick<
        WorkerProviderLifecycleOptions,
        | "store"
        | "now"
        | "prepareInstallation"
        | "isStopping"
        | "inState"
        | "withLock"
        | "serviceError"
        | "move"
      >;
      const prepareNodeEnrollment = vi.fn<
        NonNullable<WorkerProviderLifecycleOptions["prepareNodeEnrollment"]>
      >(async (record) => {
        const enrolled = fixture.store.ensureNodeEnrollment(record.environmentId);
        return {
          mode: "connect",
          setupCode: "synthetic-setup",
          setupId: enrolled.nodeSetupId!,
          openclawVersion: RECEIPT.openclawVersion,
          displayName: "Expiry fixture",
          nodeBootstrap: {
            url: "https://gateway.example.test/bootstrap",
            token: "t".repeat(43),
            sha256: "e".repeat(64),
            bytes: 1,
            openclawVersion: RECEIPT.openclawVersion,
            enabledPluginIds: [],
          },
          waitForDeviceId: async () => "expiry-node",
        };
      });
      const ensureNodeWorkerBundle = vi.fn(async () => {
        entered.resolve();
        await releaseWork.promise;
        return RECEIPT;
      });
      const registerPreparedWorkspace = vi.fn(async () => {});
      const lifecycle = createWorkerProviderLifecycle({
        ...shared,
        getConfig: () => fixture.config,
        resolveProvider: () => fixture.provider,
        projectNamespace: "gateway",
        prepareNodeBootstrap: async () => "e".repeat(64),
        prepareNodeEnrollment,
        ensureNodeWorkerBundle,
        registerPreparedWorkspace,
        credentialBroker: createWorkerCredentialBroker({
          ...shared,
          cancelInferenceEnvironment: () => {},
        }),
        callProvider: async (_environmentId, run) => await run(),
        callBootstrap: async (_installation, run) => await run(fixture.abort.signal),
        bootstrapWorker: async () => RECEIPT,
        isServiceError: (error, code) =>
          error instanceof TestWorkerServiceError && error.code === code,
        saveError: (record, error) =>
          fixture.store.recordError({
            environmentId: record.environmentId,
            state: record.state,
            error: String(error),
          }),
      });
      fixture.provider.requiresNodeEnrollment = true;
      fixture.provider.supportedExecutionModes = ["worker-turn"];
      fixture.provider.supportsProjectPreparation = () => true;
      fixture.provider.resolvePreparationTarget = () => ({
        machineClass: "standard",
        platform: "linux",
        arch: "x64",
      });
      fixture.provider.resolveAllocation = vi.fn(async () => ({
        leaseId: "expiry-lease",
        sharedHost: false,
      }));
      fixture.provider.destroy = vi.fn(async () => {
        destroyEntered.resolve();
        await releaseDestroy.promise;
      });
      fixture.provider.provision = vi.fn(async (_profile, _operationId, options) => {
        operationSignal = options?.signal;
        if (boundary === "enrollment") {
          entered.resolve();
          await releaseWork.promise;
        } else {
          await options!.project!.prepare({
            runScript: async () =>
              JSON.stringify({
                ready: true,
                preparedWorkspace: {
                  workspaceDir: `/worker/.openclaw-worker/prepared/gateway/${"9".repeat(64)}/workspace`,
                  homeDir: `/worker/.openclaw-worker/prepared/gateway/${"9".repeat(64)}/home`,
                  sourceManifestRef: `sha256:${"1".repeat(64)}`,
                  preparedManifestRef: `sha256:${"2".repeat(64)}`,
                },
              }),
            runScriptWithBudget: async () => {
              throw new Error("Completed fixture must not rerun setup");
            },
            upload: async () => {
              throw new Error("Completed fixture must not upload source");
            },
          });
        }
        const enrollment = await options!.beginNodeEnrollment!();
        if (enrollment.mode !== "connect") {
          throw new Error("Fresh reserve must use its pending enrollment");
        }
        bindCloudWorkerSetupCompletion({
          db: fixture.database.db,
          completion: {
            setupId: enrollment.setupId,
            deviceId: "expiry-node",
            completedAtMs: fixture.nowMs,
          },
        });
        return { leaseId: "expiry-lease", node: { deviceId: "expiry-node" }, sharedHost: false };
      });
      const owner = fixture.pool({
        reconcile: async (record, signal, beforeReconcile) => {
          await lifecycle.resumePrepared(record, signal, beforeReconcile);
        },
      });
      let settled = false;
      const running = fixture.schedule(owner).finally(() => {
        settled = true;
      });
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("Provisioning ended before admitted work");
        }),
      ]);
      fixture.nowMs = reserve.preparation!.expiresAtMs;
      const repeated = fixture.schedule(owner);
      const capacity = () =>
        fixture.store.preparedCapacity({
          profileId: reserve.profileId,
          projectKey: PROJECT_KEY,
          target: 1,
          maxTotal: 1,
        });
      expect(operationSignal?.aborted).toBe(false);
      expect(settled).toBe(false);
      expect(capacity()).toBe(0);
      expect(fixture.provider.destroy).not.toHaveBeenCalled();
      expect(fixture.store.get(reserve.environmentId)?.preparation).toEqual(reserve.preparation);
      releaseWork.resolve();
      await Promise.race([
        destroyEntered.promise,
        running.then(() => {
          throw new Error("Provisioning ended before cleanup");
        }),
      ]);
      expect(settled).toBe(false);
      expect(capacity()).toBe(0);
      expect(prepareNodeEnrollment).toHaveBeenCalledTimes(boundary === "enrollment" ? 0 : 1);
      expect(ensureNodeWorkerBundle).toHaveBeenCalledTimes(boundary === "enrollment" ? 0 : 1);
      expect(registerPreparedWorkspace).not.toHaveBeenCalled();
      expect(fixture.store.getCredential(reserve.environmentId)).toBeUndefined();
      expect(fixture.store.get(reserve.environmentId)).toMatchObject({
        destroyRequestedAtMs: fixture.nowMs,
        bootstrapReceipt: null,
        preparation: reserve.preparation,
      });
      releaseDestroy.resolve();
      await Promise.all([running, repeated]);
      expect(settled).toBe(true);
      expect(fixture.provider.provision).toHaveBeenCalledOnce();
      expect(fixture.provider.destroy).toHaveBeenCalledOnce();
      expect(fixture.store.get(reserve.environmentId)?.state).toBe("destroyed");
      expect(capacity()).toBe(1);
    },
  );
});
