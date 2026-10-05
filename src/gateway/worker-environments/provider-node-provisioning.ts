import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { DevicePairingPublicationUnavailableError } from "../../infra/device-pairing-publication.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  WorkerLease,
  WorkerNodeEnrollment,
  WorkerNodeRuntimeIdentity,
  WorkerNodeRuntimePreparation,
  WorkerProvider,
} from "../../plugins/types.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { readImageReserveProject } from "./image-reserve.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { createWorkerProjectPreparation } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import {
  reportWorkerProvisionAbort,
  withWorkerProvisionStage,
} from "./provider-provision-telemetry.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { requireWorkerProfile } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "callProvider"
  | "callBootstrap"
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
> &
  Pick<ReturnType<typeof createWorkerProviderOwnerLifecycle>, "failBootstrap"> & {
    commitReady: WorkerCredentialBroker["commitReady"];
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
    const prepareNodeBootstrap = options.prepareNodeBootstrap;
    if (!provider.requiresNodeEnrollment || !prepareNodeBootstrap) {
      return undefined;
    }
    let identity: WorkerNodeRuntimeIdentity;
    let installation: Awaited<ReturnType<typeof prepareBundle>>;
    // Replay also identifies the requested bytes; it must not relabel a previously enrolled node.
    try {
      const [bootstrapResult, installationResult] = await racePromiseWithAbortSignal(
        Promise.allSettled([
          withWorkerProvisionStage(record, "node-bootstrap-artifact", () =>
            prepareNodeBootstrap(record, signal),
          ),
          withWorkerProvisionStage(record, "worker-bundle-artifact", () =>
            prepareBundle(undefined, signal),
          ),
        ]),
        signal,
      );
      signal?.throwIfAborted();
      if (bootstrapResult.status === "rejected") {
        throw bootstrapResult.reason;
      }
      if (installationResult.status === "rejected") {
        throw installationResult.reason;
      }
      const nodeBootstrapSha256 = bootstrapResult.value;
      installation = installationResult.value;
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      if (
        preparation &&
        (preparation.artifacts.nodeBootstrapSha256 !== nodeBootstrapSha256 ||
          preparation.artifacts.workerArchiveSha256 !== installation.tarballSha256)
      ) {
        throw new Error("Prepared project runtime artifacts changed after admission");
      }
      identity = {
        nodeBootstrapSha256,
        executionMode:
          record.profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn",
        workerBundleSha256: installation.tarballSha256,
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
          await options.move(current, "failed", { lastError: boundedError(error) });
        } else if (current.state === "provisioning") {
          await options.saveError(current, error);
        }
      }
      throw serviceError(
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
      throw serviceError(
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
    let pendingInstallation: ReturnType<typeof prepareBundle> | undefined;
    const prepareInstallation = () =>
      (pendingInstallation ??= prepareBundle(preparedInstallation, signal));
    let enrollment: WorkerNodeEnrollment | undefined;
    let pending: Promise<WorkerNodeEnrollment> | undefined;
    const close = () => {
      if (!open) {
        return;
      }
      open = false;
      signal?.removeEventListener("abort", close);
      reportWorkerProvisionAbort(
        record,
        "runtime-operation",
        signal?.aborted ? "caller-signal" : "operation-closed",
        controller.signal,
      );
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
      const stopping = open ? options.isStopping() : false;
      if (
        !open ||
        stopping ||
        (current?.state !== "provisioning" &&
          !(
            current?.state === record.state &&
            ["ready", "idle", "attached"].includes(record.state) &&
            record.leaseId !== null &&
            current.leaseId === record.leaseId &&
            record.nodeDeviceId !== null &&
            current.nodeDeviceId === record.nodeDeviceId
          )) ||
        current.destroyRequestedAtMs !== null ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch ||
        (current.preparation?.consumedAtMs === null && current.preparation.expiresAtMs <= now())
      ) {
        reportWorkerProvisionAbort(
          record,
          "runtime-operation",
          !open
            ? "operation-closed"
            : stopping
              ? "host-stopping"
              : current && current.destroyRequestedAtMs !== null
                ? "destroy-requested"
                : current?.state !== "provisioning" ||
                    current.provisionOperationId !== record.provisionOperationId ||
                    current.ownerEpoch !== record.ownerEpoch
                  ? "owner-changed"
                  : "preparation-expired",
          controller.signal,
        );
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
      get installation() {
        return pendingInstallation ?? preparedInstallation;
      },
      prepareRuntime: prepareNodeRuntime
        ? async () => {
            assertRuntimeCurrent();
            pendingRuntime ??= (async () => {
              const artifact = await racePromiseWithAbortSignal(
                prepareInstallation(),
                controller.signal,
              );
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
        const prepared = await pending;
        assertCurrent();
        return prepared;
      },
      close,
    };
  };

  const finish = async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider,
    patch: { leaseId: string; sharedHost: boolean; desktop: WorkerLease["desktop"] | null },
    preparedInstallation?: WorkerInstallationArtifact | Promise<WorkerInstallationArtifact>,
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
      if (
        options.isStopping() ||
        !current ||
        current.state !== record.state ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch ||
        (current.preparation?.consumedAtMs === null && current.preparation.expiresAtMs <= now()) ||
        (current.preparation !== null && current.preparation.consumedAtMs !== null) ||
        (preparation !== undefined &&
          (!enrollmentOwner?.nodeSetupId ||
            current.nodeSetupId !== enrollmentOwner.nodeSetupId ||
            current.nodeDeviceId !== lease.node.deviceId)) ||
        current.destroyRequestedAtMs !== null
      ) {
        throw new Error("Prepared worker provisioning owner is no longer current");
      }
      return current;
    };
    let nodeBuild: WorkerAdmissionHandshake;
    try {
      assertCurrent();
      const ensureNodeWorkerBundle = options.ensureNodeWorkerBundle;
      if (!ensureNodeWorkerBundle) {
        throw new Error("Device worker bundle installer is unavailable");
      }
      const artifact = await prepareBundle(await preparedInstallation, cancellation?.signal);
      assertCurrent();
      if (preparation && artifact.tarballSha256 !== preparation.artifacts.workerArchiveSha256) {
        throw new Error("Worker bundle differs from its admitted preparation");
      }
      // Conversation attachments do not run the agent; only worker turns need its prewarm.
      const prewarm =
        record.profileSnapshot.executionMode !== "remote-exec" &&
        !(await options.store.hasSessionAttachment(record.environmentId));
      assertCurrent();
      nodeBuild = await withWorkerProvisionStage(
        record,
        "node-bundle-install",
        () =>
          ensureNodeWorkerBundle({
            reason: "provision",
            environmentId: record.environmentId,
            deviceId: lease.node.deviceId,
            artifact,
            prewarm,
            signal: cancellation?.signal,
            assertCurrent,
          }),
        lease.leaseId,
      );
      assertCurrent();
      if (preparation) {
        const imageReserve = readImageReserveProject(record.profileSnapshot.project);
        if (lease.sharedHost !== false || (imageReserve && preparedWorkspace !== undefined)) {
          throw new Error("Prepared worker requires its dedicated registered workspace");
        }
        if (!imageReserve) {
          const registerPreparedWorkspace = options.registerPreparedWorkspace;
          if (
            !preparedWorkspace ||
            preparedWorkspace.preparationKey !== preparation.key ||
            preparedWorkspace.cacheKey !== preparation.cacheKey ||
            !registerPreparedWorkspace
          ) {
            throw new Error("Prepared worker requires its dedicated registered workspace");
          }
          await withWorkerProvisionStage(
            record,
            "workspace-registration",
            () =>
              registerPreparedWorkspace({
                record: assertCurrent(),
                deviceId: lease.node.deviceId,
                workspace: preparedWorkspace,
                assertCurrent,
                signal: cancellation?.signal,
              }),
            lease.leaseId,
          );
          assertCurrent();
        }
      }
    } catch (error) {
      if (error instanceof DevicePairingPublicationUnavailableError) {
        createSubsystemLogger("gateway/worker-environments").warn(
          "worker_pairing_publication_unavailable",
          {
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            provisionOperationId: record.provisionOperationId,
            stage: "post-enrollment-bundle-install",
            publicationState: error.publicationState,
          },
        );
      }
      await cancellation?.settleStopIntent();
      return await options.failBootstrap(record, lease.leaseId, provider, error, nodePatch);
    }
    return withWorkerProvisionStage(
      record,
      "ready-commit",
      () =>
        options.commitReady(
          record,
          { ...nodeBuild, installKind: "bundle" },
          nodePatch,
          assertCurrent,
        ),
      lease.leaseId,
    );
  };

  const resume = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    authority: { signal: AbortSignal; assertCurrent: () => void },
  ) => {
    const assertCurrent = () => {
      authority.signal.throwIfAborted();
      authority.assertCurrent();
      const current = options.store.get(record.environmentId);
      if (
        options.isStopping() ||
        current?.ownerEpoch !== record.ownerEpoch ||
        current.state !== record.state ||
        current.leaseId !== record.leaseId ||
        current.nodeDeviceId !== record.nodeDeviceId ||
        current.destroyRequestedAtMs !== null
      ) {
        throw new Error("Worker resumption lost its exact lease owner");
      }
    };
    assertCurrent();
    if (!provider.resume || !record.leaseId || !record.nodeDeviceId) {
      throw new Error("Worker provider has no exact node resumption operation");
    }
    if (installation.install !== "bundle" || !options.ensureNodeWorkerBundle) {
      throw new Error("Worker resumption has no current bundle installer");
    }
    const resumeLease = provider.resume;
    const deviceId = record.nodeDeviceId;
    const lease = {
      leaseId: record.leaseId,
      profile: requireWorkerProfile(record.profileSnapshot.settings),
    };
    const inspection = await options.callProvider(record.environmentId, () =>
      provider.inspect(lease),
    );
    assertCurrent();
    if (inspection.status !== "active" && inspection.status !== "dormant") {
      throw new Error("Worker resumption requires a recognized lease");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([authority.signal, controller.signal]);
    const operation = createEnrollmentOperation(
      record,
      provider,
      signal,
      installation,
      undefined,
      assertCurrent,
    );
    let open = true;
    const assertResumeCurrent = () => {
      if (!open) {
        throw new Error("Worker resumption operation closed");
      }
      assertCurrent();
    };
    try {
      const disposition = await options.callProvider(record.environmentId, () =>
        resumeLease(lease, {
          signal,
          assertCurrent: assertResumeCurrent,
          beginNodeEnrollment: async () => {
            assertResumeCurrent();
            const enrollment = await operation?.begin();
            assertResumeCurrent();
            if (!enrollment || enrollment.mode !== "resume" || enrollment.deviceId !== deviceId) {
              throw new Error("Worker resumption cannot replace its paired node identity");
            }
            return enrollment;
          },
        }),
      );
      assertCurrent();
      if (disposition === "unsupported") {
        return;
      }
      if (disposition !== "resumed") {
        throw new Error("Worker provider returned an invalid resumption outcome");
      }
      const observed = await options.callProvider(record.environmentId, () =>
        provider.inspect(lease),
      );
      assertCurrent();
      if (observed.status !== "active") {
        throw new Error("Worker lease did not become active after resumption");
      }
      const ensureNodeWorkerBundle = options.ensureNodeWorkerBundle;
      const receipt = await options.callBootstrap(installation, (timeoutSignal) =>
        ensureNodeWorkerBundle({
          reason: "refresh",
          environmentId: record.environmentId,
          deviceId,
          artifact: installation,
          prewarm: record.profileSnapshot.executionMode !== "remote-exec",
          signal: AbortSignal.any([signal, timeoutSignal]),
          assertCurrent,
        }),
      );
      assertCurrent();
      if (!sameWorkerBuild(receipt, installation)) {
        throw new Error("Worker resumption returned another runtime build");
      }
    } finally {
      open = false;
      controller.abort();
      operation?.close();
    }
  };
  return { prepare, createEnrollmentOperation, finish, resume };
}
