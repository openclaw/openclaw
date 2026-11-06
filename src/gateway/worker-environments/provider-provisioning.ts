import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import * as types from "../../plugins/types.js";
import * as receipts from "../../plugins/worker-resource-receipt.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { MAX_NODE_BOOTSTRAP_TIMEOUT_MS } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import {
  WorkerEnvironmentServiceError,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import type { WorkerInitialSnapshotCustody } from "./preparation-identity.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import * as projects from "./provider-project-preparation.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import type { createWorkerRetainedLifecycle } from "./provider-retained-lifecycle.js";
import type { createWorkerSshBootstrap } from "./provider-ssh-bootstrap.js";
import * as check from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type Owners = Pick<
  ReturnType<typeof createWorkerProviderOwnerLifecycle>,
  | "requireCurrentOwner"
  | "requireCurrentProvisionOwner"
  | "failBootstrap"
  | "finishConfirmedProvisionCleanup"
  | "preserveIndeterminateProvisionCleanup"
>;

export function createWorkerProvisioning(
  options: WorkerProviderLifecycleOptions &
    Owners & {
      ownerSignal: AbortSignal;
      nodeProvisioning: ReturnType<typeof createWorkerNodeProvisioning>;
      retained: Pick<
        ReturnType<typeof createWorkerRetainedLifecycle>,
        "resumeProvision" | "admitProvision"
      >;
      dedicatedLeases: ReturnType<typeof createDedicatedNodeLeaseAttestations>;
      finishBootstrap: ReturnType<typeof createWorkerSshBootstrap>;
      startStatuses: Map<string, { ownerEpoch: number; status: WorkerEnvironmentStartStatus }>;
    },
) {
  const {
    store,
    callProvider,
    move,
    saveError,
    nodeProvisioning,
    retained,
    dedicatedLeases,
    finishBootstrap,
    startStatuses,
    requireCurrentOwner,
    requireCurrentProvisionOwner,
    failBootstrap,
    finishConfirmedProvisionCleanup,
    preserveIndeterminateProvisionCleanup,
  } = options;
  const finishProvision = async (
    initialRecord: WorkerEnvironmentRecord,
    provider: types.WorkerProvider,
    workSignal: AbortSignal,
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    nodeRuntimeIdentity?: types.WorkerNodeRuntimeIdentity,
    beforeProvision?: () => void,
    repositorySource?: projects.WorkerProviderRepositorySource,
    wakeRetained?: () => void,
    recordInitialSnapshot?: (custody: WorkerInitialSnapshotCustody) => void,
  ) => {
    let record = initialRecord;
    let lease: types.WorkerLease;
    let attemptOpen = true;
    const closedAttempt = new Error("Worker provisioning operation is closed");
    let preparationComplete = false;
    let provisioningTransition: Promise<WorkerEnvironmentRecord> | undefined;
    let executionMode: types.WorkerExecutionMode | undefined;
    let enrollmentOperation: ReturnType<typeof nodeProvisioning.createEnrollmentOperation>;
    let projectOperation:
      | Awaited<ReturnType<typeof projects.prepareWorkerProviderProject>>
      | undefined;
    try {
      const profile = check.requireWorkerProfile(record.profileSnapshot.settings);
      if (record.resourceReceipt && !provider.supportsResourceReceipts) {
        throw new Error("Worker provider cannot honor the recorded resource receipt");
      }
      if (
        record.retention &&
        (!provider.setRetainedState ||
          !provider.requiresNodeEnrollment ||
          !provider.supportsResourceReceipts)
      ) {
        throw new types.WorkerProviderError(
          "Retained workers require exact lifecycle and node enrollment support",
        );
      }
      const requestedExecutionMode = record.profileSnapshot.executionMode;
      if (
        requestedExecutionMode !== undefined &&
        requestedExecutionMode !== "worker-turn" &&
        requestedExecutionMode !== "remote-exec"
      ) {
        throw new types.WorkerProviderError(
          "Worker environment has an invalid placement execution mode",
        );
      }
      executionMode = requestedExecutionMode;
      if (executionMode && !provider.supportedExecutionModes?.includes(executionMode)) {
        // Current provider metadata cannot disprove allocation by an earlier attempt.
        throw new Error(
          `Worker provider ${provider.id} does not support ${executionMode} placement`,
        );
      }
      // Grants are issued after allocation. Reserve the core policy's maximum now,
      // including the connection wait that starts after the bootstrap command exits.
      const nodeBootstrapTimeoutMs = provider.requiresNodeEnrollment
        ? MAX_NODE_BOOTSTRAP_TIMEOUT_MS
        : undefined;
      const providerTimeoutMs =
        options.providerCallTimeoutMs === undefined
          ? check.requireProviderOperationTimeoutMs(
              "provision",
              provider.resolveProvisionTimeoutMs?.(profile, { nodeBootstrapTimeoutMs }),
            )
          : undefined;
      const preparation = readWorkerPreparation(record.profileSnapshot);
      const machineClass =
        preparation?.target.machineClass ??
        (typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined);
      const os =
        typeof record.profileSnapshot.os === "string" ? record.profileSnapshot.os : undefined;
      enrollmentOperation = nodeProvisioning.createEnrollmentOperation(
        record,
        provider,
        workSignal,
        preparedInstallation,
        nodeRuntimeIdentity,
        beforeProvision,
      );
      const assertCurrent = () => {
        cancellation?.assertActive();
        if (!attemptOpen || options.isStopping()) {
          throw closedAttempt;
        }
        beforeProvision?.();
        record = requireCurrentProvisionOwner(record, enrollmentOperation?.setupId);
        return record;
      };
      const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
      if (project) {
        if (
          !provider.supportsProjectPreparation?.(profile, machineClass, os) ||
          !options.projectNamespace
        ) {
          throw new Error("Worker provider cannot resume its prepared project contract");
        }
        projectOperation = await projects.prepareWorkerProviderProject({
          project,
          preparation,
          record,
          namespace: options.projectNamespace,
          getConfig: options.getConfig,
          requireCurrent: assertCurrent,
          signal: workSignal,
          repositorySource,
        });
      }
      if (record.retention && record.resourceReceipt && wakeRetained) {
        // An explicit retry re-admits source and caller authority before reopening compute.
        // Background provisioning retains custody but never supplies wake authority.
        await retained.resumeProvision(
          record,
          () => {
            assertCurrent();
            projectOperation?.project.assertCurrent();
            wakeRetained();
          },
          workSignal,
        );
      }
      const provisionOptions = {
        nodeBootstrapTimeoutMs,
        profileId: record.profileId,
        assertCurrent,
        ...(record.resourceReceipt ? { resourceReceipt: record.resourceReceipt } : {}),
        ...(record.retention ? { retention: record.retention.policy } : {}),
        recordResourceReceipt: async (value) => {
          assertCurrent();
          if (!provider.supportsResourceReceipts) {
            throw new Error("Worker provider does not support resource receipts");
          }
          const receipt = receipts.requireWorkerResourceReceipt(value);
          record = await store.recordResourceReceipt({
            environmentId: record.environmentId,
            provisionOperationId: record.provisionOperationId,
            receipt,
            assertCurrent,
          });
          assertCurrent();
        },
        reportStartStatus: (status: WorkerEnvironmentStartStatus) => {
          const current = assertCurrent();
          startStatuses.set(current.environmentId, { ownerEpoch: current.ownerEpoch, status });
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        },
        ...(machineClass ? { machineClass } : {}),
        ...(os ? { os } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(enrollmentOperation
          ? {
              beginNodeEnrollment: enrollmentOperation.begin,
              prepareNodeRuntime: enrollmentOperation.prepareRuntime,
              nodeRuntimeIdentity,
            }
          : {}),
        signal: workSignal,
        ...(projectOperation ? { project: projectOperation.project } : {}),
      } satisfies NonNullable<Parameters<types.WorkerProvider["provision"]>[2]>;
      cancellation?.assertActive();
      const provision = async () => {
        assertCurrent();
        const preparedProvision = await provider.prepareProvision?.(
          profile,
          record.provisionOperationId,
          provisionOptions,
        );
        const current = assertCurrent();
        if (provider.prepareProvision && typeof preparedProvision !== "function") {
          throw new Error("Worker provider preparation must return an allocation operation");
        }
        // Preparation and allocation share one timeout and settlement owner. Only a
        // fresh requested row proves there was no earlier allocation to clean up.
        record =
          current.state === "requested"
            ? await (provisioningTransition = move(
                current,
                "provisioning",
                undefined,
                assertCurrent,
              ))
            : current;
        assertCurrent();
        preparationComplete = true;
        return preparedProvision
          ? preparedProvision()
          : provider.provision(profile, record.provisionOperationId, provisionOptions);
      };
      const trackedProvision = cancellation ? cancellation.retainProvider(provision) : provision;
      lease = check.requireWorkerLease(
        await callProvider(record.environmentId, "provision", trackedProvision, providerTimeoutMs),
      );
      if (record.retention && !record.resourceReceipt) {
        throw new Error("Retained worker allocation did not persist its exact resource receipt");
      }
      receipts.assertWorkerResourceReceiptMatch(record.resourceReceipt, lease.resourceReceipt);
    } catch (error) {
      attemptOpen = false;
      // A provider timeout can precede delivery of its committed provisioning transition.
      // Join that write, without joining provider work that may still be blocked.
      if (provisioningTransition) {
        try {
          const transitioned = await provisioningTransition;
          // A later receipt write belongs to this attempt; do not replace it with
          // the earlier transition snapshot when the provider eventually fails.
          record = record.resourceReceipt ? record : transitioned;
        } catch (transitionError) {
          if (transitionError !== closedAttempt) {
            throw transitionError;
          }
        }
      }
      await cancellation?.settleStopIntent();
      if (types.WorkerProviderError.isCleanupIndeterminate(error)) {
        return preserveIndeterminateProvisionCleanup(record, error);
      }
      // A cancelled attempt may already own a paid allocation, even when its late
      // provider error looks permanent. Keep it available for canonical teardown.
      cancellation?.assertActive();
      if (types.WorkerProviderError.isCleanupComplete(error)) {
        return await finishConfirmedProvisionCleanup(record, error);
      }
      options.ownerSignal.throwIfAborted();
      const detail = boundedError(error);
      const permanent =
        error instanceof types.WorkerProviderError ||
        (error instanceof WorkerEnvironmentServiceError && error.code === "invalid_profile");
      // A current refusal cannot disprove allocation by an earlier attempt.
      const terminalFailure =
        record.state === "requested" ||
        (provisioningTransition !== undefined &&
          preparationComplete &&
          permanent &&
          !record.resourceReceipt);
      await (terminalFailure
        ? move(record, "failed", { lastError: detail })
        : saveError(record, error));
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      throw serviceError(
        terminalFailure && permanent ? "invalid_profile" : "provider_failure",
        `Worker provider ${!terminalFailure ? "operation failed" : permanent ? "rejected profile" : "preparation failed"}: ${detail}`,
      );
    } finally {
      // A replay keeps its durable owner after timeout; this invocation must still close.
      attemptOpen = false;
      if (startStatuses.delete(record.environmentId)) {
        sessionChanges.emit({ all: true, scope: "worker-environments" });
      }
      projectOperation?.close();
      enrollmentOperation?.close();
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
      ...(lease.node
        ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null }
        : { nodeDeviceId: null, sshEndpoint: lease.ssh }),
    };
    if (cancellation?.signal.aborted) {
      await cancellation.settleStopIntent();
      await move(requireCurrentOwner(record), "draining", patch);
      cancellation.assertActive();
    }
    const leaseModeError = check.resolveWorkerLeaseTransportError(
      provider,
      lease.node ? "node" : "ssh",
      executionMode,
    );
    if (leaseModeError) {
      return await failBootstrap(
        record,
        lease.leaseId,
        provider,
        leaseModeError,
        patch,
        "invalid_profile",
      );
    }
    if (lease.node) {
      const snapshot = projectOperation?.getInitialSnapshot();
      const initialNode = enrollmentOperation?.initialNode;
      let isNodeCurrent: (() => boolean) | undefined;
      const ready = await nodeProvisioning.finish(
        record,
        lease,
        provider,
        workSignal,
        patch,
        enrollmentOperation?.installation ?? preparedInstallation,
        cancellation,
        projectOperation?.getPreparedWorkspace(),
        beforeProvision,
        snapshot &&
          initialNode && {
            snapshot,
            initialNode,
            registered: (current) => {
              isNodeCurrent = current;
            },
          },
      );
      if (ready.state === "ready" && snapshot && initialNode && isNodeCurrent?.()) {
        beforeProvision?.();
        recordInitialSnapshot?.({
          environmentId: ready.environmentId,
          provisionOperationId: ready.provisionOperationId,
          nodeDeviceId: lease.node.deviceId,
          snapshot,
          isNodeCurrent,
        });
      }
      dedicatedLeases.note(ready, lease.sharedHost === false);
      return ready.retention ? await retained.admitProvision(ready, workSignal) : ready;
    }
    const bootstrapping = await move(record, "bootstrapping", patch);
    let installation = preparedInstallation;
    if (!installation) {
      try {
        // A persisted provisioning row can represent an allocation whose response was lost.
        // Replay the idempotent provider operation before packaging can terminalize that lease.
        installation = await options.prepareInstallation(
          check.requireInstall(bootstrapping),
          workSignal,
        );
        cancellation?.assertActive();
      } catch (error) {
        await cancellation?.settleStopIntent();
        options.ownerSignal.throwIfAborted();
        return await failBootstrap(bootstrapping, lease.leaseId, provider, error);
      }
    }
    return finishBootstrap(bootstrapping, provider, installation, cancellation);
  };

  return finishProvision;
}
