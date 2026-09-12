import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerLease,
  WorkerNodeEnrollment,
  WorkerNodeRuntimeIdentity,
  WorkerNodeRuntimePreparation,
  WorkerProvider,
} from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { createWorkerProjectPreparation } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentTransitionPatch } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "now"
  | "isStopping"
  | "prepareNodeBootstrap"
  | "prepareInstallation"
  | "prepareNodeRuntime"
  | "closeNodeRuntime"
  | "prepareNodeEnrollment"
  | "closeNodeEnrollment"
  | "ensureNodeWorkerBundle"
  | "registerPreparedWorkspace"
  | "move"
  | "saveError"
  | "serviceError"
> & {
  commitReady: WorkerCredentialBroker["commitReady"];
  failBootstrap: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
    patch: WorkerEnvironmentTransitionPatch,
  ) => Promise<never>;
};

export function createWorkerNodeProvisioning(options: WorkerNodeProvisioningOptions) {
  const now = options.now ?? Date.now;
  const prepareBundle = async (
    preparedInstallation?: WorkerInstallationArtifact,
    signal?: AbortSignal,
  ) => {
    // Packaging belongs to the service; runtime grants and node installation consume
    // the same prepared artifact without retaining a cancelled packaging wait.
    const artifact =
      preparedInstallation?.install === "bundle"
        ? preparedInstallation
        : await options.prepareInstallation("bundle", signal);
    signal?.throwIfAborted();
    if (artifact.install !== "bundle") {
      throw new Error("Worker bundle preparation returned the wrong install channel");
    }
    return artifact;
  };

  const prepare = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    signal?: AbortSignal,
    beforeProvision?: () => void,
  ) => {
    if (!provider.requiresNodeEnrollment || !options.prepareNodeBootstrap) {
      return undefined;
    }
    let identity: WorkerNodeRuntimeIdentity;
    let installation: WorkerInstallationArtifact | undefined;
    // Replay also identifies the requested bytes; it must not relabel a previously enrolled node.
    try {
      const nodeBootstrapSha256 = await options.prepareNodeBootstrap(record, signal);
      if (record.profileSnapshot.project) {
        installation = await prepareBundle(undefined, signal);
      }
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      if (
        preparation &&
        (preparation.artifacts.nodeBootstrapSha256 !== nodeBootstrapSha256 ||
          installation?.install !== "bundle" ||
          preparation.artifacts.workerArchiveSha256 !== installation.tarballSha256)
      ) {
        throw new Error("Prepared project runtime artifacts changed after admission");
      }
      identity = {
        nodeBootstrapSha256,
        executionMode:
          record.profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn",
        ...(installation?.install === "bundle"
          ? { workerBundleSha256: installation.tarballSha256 }
          : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      const current = options.store.get(record.environmentId);
      if (
        current?.provisionOperationId === record.provisionOperationId &&
        current.ownerEpoch === record.ownerEpoch &&
        current.destroyRequestedAtMs === null
      ) {
        if (current.state === "requested") {
          options.move(current, "failed", { lastError: boundedError(error) });
        } else if (current.state === "provisioning") {
          options.saveError(current, error);
        }
      }
      throw options.serviceError(
        "bootstrap_failure",
        `Worker node bootstrap preparation failed: ${boundedError(error)}`,
      );
    }
    beforeProvision?.();
    const current = options.store.get(record.environmentId);
    if (
      options.isStopping() ||
      !current ||
      current.state !== record.state ||
      current.provisionOperationId !== record.provisionOperationId ||
      current.ownerEpoch !== record.ownerEpoch ||
      current.destroyRequestedAtMs !== null
    ) {
      throw options.serviceError(
        "invalid_state",
        "Worker provisioning changed during bootstrap preparation",
      );
    }
    return { identity, installation };
  };

  const createEnrollmentOperation = (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    signal?: AbortSignal,
    preparedInstallation?: WorkerInstallationArtifact,
    identity?: WorkerNodeRuntimeIdentity,
    beforeProvision?: () => void,
  ) => {
    if (provider.requiresNodeEnrollment !== true) {
      return undefined;
    }
    const prepareNodeEnrollment = options.prepareNodeEnrollment;
    const prepareNodeRuntime = options.prepareNodeRuntime;
    if (!prepareNodeEnrollment) {
      throw new Error("Worker node enrollment runtime is unavailable");
    }
    let open = true;
    const controller = new AbortController();
    let runtime: WorkerNodeRuntimePreparation | undefined;
    let pendingRuntime: Promise<WorkerNodeRuntimePreparation> | undefined;
    let enrollment: WorkerNodeEnrollment | undefined;
    let pending: Promise<WorkerNodeEnrollment> | undefined;
    const close = () => {
      if (!open) {
        return;
      }
      open = false;
      signal?.removeEventListener("abort", close);
      controller.abort();
      if (runtime) {
        options.closeNodeRuntime?.(runtime);
        runtime = undefined;
      }
      if (enrollment) {
        options.closeNodeEnrollment?.(enrollment);
        enrollment = undefined;
      }
    };
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) {
      close();
    }
    const assertCurrent = () => {
      beforeProvision?.();
      const current = options.store.get(record.environmentId);
      if (
        !open ||
        options.isStopping() ||
        current?.state !== "provisioning" ||
        current.destroyRequestedAtMs !== null ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch ||
        (current.preparation?.consumedAtMs === null && current.preparation.expiresAtMs <= now())
      ) {
        controller.abort();
        throw new DOMException("Worker provisioning operation is closed", "AbortError");
      }
    };
    const assertRuntimeCurrent = () => {
      assertCurrent();
      if (pending) {
        throw new Error("Worker node enrollment has already begun");
      }
    };
    const assertRuntimeIdentity = (
      prepared: WorkerNodeRuntimePreparation | WorkerNodeEnrollment,
    ) => {
      if (
        identity &&
        (prepared.nodeBootstrap.sha256 !== identity.nodeBootstrapSha256 ||
          ("workerBundle" in prepared &&
            identity.workerBundleSha256 !== undefined &&
            prepared.workerBundle.sha256 !== identity.workerBundleSha256))
      ) {
        throw new Error("Worker node runtime changed after provisioning preparation");
      }
    };
    return {
      prepareRuntime: prepareNodeRuntime
        ? async () => {
            assertRuntimeCurrent();
            pendingRuntime ??= (async () => {
              const artifact = await prepareBundle(preparedInstallation, controller.signal);
              assertRuntimeCurrent();
              const prepared = await prepareNodeRuntime(record, artifact, controller.signal);
              try {
                assertRuntimeCurrent();
                assertRuntimeIdentity(prepared);
              } catch (error) {
                options.closeNodeRuntime?.(prepared);
                throw error;
              }
              runtime = prepared;
              return prepared;
            })();
            return await pendingRuntime;
          }
        : undefined,
      begin: async () => {
        assertCurrent();
        if (runtime) {
          options.closeNodeRuntime?.(runtime);
          runtime = undefined;
        }
        pending ??= prepareNodeEnrollment(record, controller.signal).then((prepared) => {
          // A provider timeout can close this operation during artifact preparation.
          try {
            assertCurrent();
            assertRuntimeIdentity(prepared);
          } catch (error) {
            options.closeNodeEnrollment?.(prepared);
            throw error;
          }
          enrollment = prepared;
          return prepared;
        });
        return await pending;
      },
      close,
    };
  };

  const finish = async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider,
    patch: { leaseId: string; sharedHost: boolean; desktop: WorkerLease["desktop"] | null },
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    preparedWorkspace?: ReturnType<
      ReturnType<typeof createWorkerProjectPreparation>["getPreparedWorkspace"]
    >,
    beforeProvision?: () => void,
  ): Promise<WorkerEnvironmentRecord> => {
    const nodePatch = {
      ...patch,
      nodeDeviceId: lease.node.deviceId,
      sshEndpoint: null,
    };
    const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
    const enrollmentOwner = options.store.get(record.environmentId);
    const assertCurrent = () => {
      cancellation?.assertActive();
      beforeProvision?.();
      const current = options.store.get(record.environmentId);
      if (current?.preparation?.consumedAtMs === null && current.preparation.expiresAtMs <= now()) {
        options.store.requestDestroy({
          environmentId: current.environmentId,
          state: current.state,
          lastError: "Unused prepared worker expired before readiness",
        });
      }
      if (
        options.isStopping() ||
        !current ||
        current.state !== record.state ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch ||
        (current.preparation !== null && current.preparation.consumedAtMs !== null) ||
        (preparation !== undefined &&
          (!enrollmentOwner?.nodeSetupId ||
            current.nodeSetupId !== enrollmentOwner.nodeSetupId ||
            current.nodeDeviceId !== lease.node.deviceId)) ||
        options.store.get(record.environmentId)?.destroyRequestedAtMs !== null
      ) {
        throw new Error("Prepared worker provisioning owner is no longer current");
      }
    };
    let nodeBuild: WorkerAdmissionHandshake;
    try {
      assertCurrent();
      if (!options.ensureNodeWorkerBundle) {
        throw new Error("Device worker bundle installer is unavailable");
      }
      const artifact = await prepareBundle(preparedInstallation, cancellation?.signal);
      assertCurrent();
      if (preparation && artifact.tarballSha256 !== preparation.artifacts.workerArchiveSha256) {
        throw new Error("Worker bundle differs from its admitted preparation");
      }
      nodeBuild = await options.ensureNodeWorkerBundle({
        deviceId: lease.node.deviceId,
        artifact,
        // Remote execution uses its harness runtime; unspecified mode retains worker prewarming.
        prewarm: record.profileSnapshot.executionMode !== "remote-exec",
        signal: cancellation?.signal,
      });
      assertCurrent();
      if (preparation) {
        if (
          lease.sharedHost !== false ||
          !preparedWorkspace ||
          preparedWorkspace.preparationKey !== preparation.key ||
          preparedWorkspace.cacheKey !== preparation.cacheKey ||
          !options.registerPreparedWorkspace
        ) {
          throw new Error("Prepared worker requires its dedicated registered workspace");
        }
        await options.registerPreparedWorkspace({
          record: options.store.get(record.environmentId)!,
          deviceId: lease.node.deviceId,
          workspace: preparedWorkspace,
          assertCurrent,
          signal: cancellation?.signal,
        });
        assertCurrent();
      }
    } catch (error) {
      return await options.failBootstrap(record, lease.leaseId, provider, error, nodePatch);
    }
    return options.commitReady(record, { ...nodeBuild, installKind: "bundle" }, nodePatch);
  };

  return { prepare, createEnrollmentOperation, finish };
}
