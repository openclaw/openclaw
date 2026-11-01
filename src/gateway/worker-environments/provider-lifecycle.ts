import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import * as types from "../../plugins/types.js";
import * as receipts from "../../plugins/worker-resource-receipt.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { MAX_NODE_BOOTSTRAP_TIMEOUT_MS } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import {
  WorkerEnvironmentServiceError,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import { createWorkerReconcileTrace } from "./environment-operation.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { createWorkerProviderIntent, failUnallocatedImageIntent } from "./provider-intent.js";
import { createWorkerLeaseInspection, ORPHANED_LEASE_ERROR } from "./provider-lease-inspection.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerMachineCatalog } from "./provider-machine-catalog.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import { createPreparedWorkerRecovery } from "./provider-prepared-recovery.js";
import * as projects from "./provider-project-preparation.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { createWorkerRetainedLifecycle } from "./provider-retained-lifecycle.js";
import { createWorkerRuntimeRefresher } from "./provider-runtime-refresh.js";
import { createWorkerSshBootstrap } from "./provider-ssh-bootstrap.js";
import * as check from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

export function createWorkerProviderLifecycle(
  options: WorkerProviderLifecycleOptions & { ownerSignal: AbortSignal },
) {
  const { store, callProvider, move, saveError, now = Date.now } = options;
  const startStatuses = new Map<
    string,
    { ownerEpoch: number; status: WorkerEnvironmentStartStatus }
  >();
  const { commitReady, ensurePendingCredential } = options.credentialBroker;
  const dedicatedLeases = createDedicatedNodeLeaseAttestations(options, (record) =>
    requireCurrentOwner(record),
  );

  const providerFor = (providerId: string): types.WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const {
    identityResolverFor,
    requireCurrentOwner,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    failBootstrap,
    finishConfirmedProvisionCleanup,
    preserveIndeterminateProvisionCleanup,
    destroy,
    reclaim,
    retireMismatchedLease,
  } = createWorkerProviderOwnerLifecycle({
    ...options,
    providerFor,
    onOwnerStopped: dedicatedLeases.retire,
  });

  const leaseInspection = createWorkerLeaseInspection({
    ...options,
    providerFor,
    dedicatedLeases,
    lifecycleLease,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    finishDestroy,
  });
  const machineCatalog = createWorkerMachineCatalog(options);

  const expirePrepared = async (record: WorkerEnvironmentRecord) =>
    record.preparation?.consumedAtMs === null && record.preparation.expiresAtMs <= now()
      ? store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          lastError: "Unused prepared worker expired",
          assertCurrent: () => requireCurrentOwner(record),
        })
      : record;

  const nodeProvisioning = createWorkerNodeProvisioning({
    ...options,
    commitReady,
    failBootstrap,
  });

  const runtimeRefresher = createWorkerRuntimeRefresher({
    ...options,
    requireCurrentOwner,
    stopOwner,
    identityResolverFor,
  });

  const retained = createWorkerRetainedLifecycle({
    ...options,
    providerFor,
    requireCurrentOwner,
    refreshRuntime: runtimeRefresher.refresh,
  });
  const finishBootstrap = createWorkerSshBootstrap({
    ...options,
    identityResolverFor,
    failBootstrap,
    requireCurrentOwner,
  });

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
      if (record.retention && (!provider.setRetainedState || !provider.requiresNodeEnrollment)) {
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
        const current = requireCurrentOwner(record);
        if (current.destroyRequestedAtMs !== null) {
          throw new Error("Worker provisioning operation is closed");
        }
        return current;
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
      );
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

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
    repositorySource?: projects.WorkerProviderRepositorySource,
    wakeRetained?: () => void,
  ) => {
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    const pending = await expirePrepared(record);
    if (pending.destroyRequestedAtMs !== null) {
      return finishDestroy(pending, provider);
    }
    // Shutdown cancels this attempt; only request cancellation records destroy intent.
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    try {
      beforeProvision?.();
      const preparedNode = await nodeProvisioning.prepare(
        record,
        provider,
        workSignal,
        beforeProvision,
      );
      let installation: WorkerInstallationArtifact | undefined = preparedNode?.installation;
      cancellation?.assertActive();
      if (
        record.state === "requested" &&
        record.destroyRequestedAtMs === null &&
        !installation &&
        provider.provisionBeforeInstallation !== true
      ) {
        try {
          // Fresh requests package before allocation. Once provisioning is durable, provider replay
          // must happen first because the previous response may have been lost after allocation.
          installation = await options.prepareInstallation(
            check.requireInstall(record),
            workSignal,
          );
        } catch (error) {
          cancellation?.assertActive();
          options.ownerSignal.throwIfAborted();
          const detail = boundedError(error);
          await move(record, "failed", { lastError: detail });
          throw serviceError(
            "bootstrap_failure",
            `Worker installation preparation failed: ${detail}`,
          );
        }
        cancellation?.assertActive();
      }
      beforeProvision?.();
      return await finishProvision(
        pending,
        provider,
        workSignal,
        installation,
        cancellation,
        preparedNode?.identity,
        beforeProvision,
        repositorySource,
        wakeRetained,
      );
    } catch (error) {
      return await failUnallocatedImageIntent(options, record, error, workSignal);
    } finally {
      await cancellation?.close();
    }
  };

  const reconcileRecord = async (
    initialRecord: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
  ): Promise<void> => {
    const step = createWorkerReconcileTrace(initialRecord);
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    workSignal.throwIfAborted();
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void (await finishDestroy(record));
    }
    if (
      record.retention &&
      record.destroyRequestedAtMs === null &&
      ["ready", "idle", "attached"].includes(record.state)
    ) {
      await retained.reconcile(record, workSignal);
      return;
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (
      record.destroyRequestedAtMs === null &&
      ["ready", "idle", "attached"].includes(record.state)
    ) {
      try {
        currentBundle = await step("installation", () =>
          options.prepareInstallation("bundle", workSignal),
        );
        if (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, currentBundle)) {
          const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
          if (record.state !== "attached" || sessionId) {
            await step("credential", () => ensurePendingCredential(record, sessionId ?? null));
            record = store.get(record.environmentId) ?? record;
          }
        }
      } catch {
        workSignal.throwIfAborted();
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: types.WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      await saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      await (
        record.destroyRequestedAtMs !== null
          ? finishDestroy(record, provider, workSignal)
          : resumeProvision(record, provider, signal, retainProviderSettlement, beforeProvision)
      ).catch(() => undefined);
      return;
    }
    if (
      record.resourceReceipt &&
      (record.destroyRequestedAtMs !== null || record.state === "destroying")
    ) {
      // A completed delete may no longer expose live inspection labels. Retry the exact
      // recorded cleanup, whose provider result owns confirmation, not an inventory miss.
      await finishDestroy(record, provider, workSignal).catch(() => undefined);
      return;
    }
    if (await step("mismatched-lease", () => retireMismatchedLease(record, provider))) {
      return;
    }
    const lease = lifecycleLease(record, leaseId);
    const inspection = await dedicatedLeases.inspect(record, provider, lease, workSignal);
    if (!inspection) {
      return;
    }
    const { status } = inspection;
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed" || status === "unknown") {
      await leaseInspection.settleLostLease(record, provider, status);
      return;
    }
    if (status === "dormant") {
      if (teardownExpected) {
        await finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    record = await dedicatedLeases.reconcileSharedHost(record, leaseId, inspection, stopOwner);
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (!record.sshEndpoint || record.state === "attached") {
      // Failed upgrades retain the old receipt and exact lease for recovery.
      await runtimeRefresher
        .refresh(record, provider, currentBundle, workSignal)
        .catch(async (error: unknown) => {
          workSignal.throwIfAborted();
          await saveError(record, error);
        });
      return;
    }
    if (record.state === "draining") {
      // Draining without destroy intent is durable provider-loss cleanup.
      record = await stopOwner(record);
      await move(record, "orphaned", { lastError: record.lastError ?? ORPHANED_LEASE_ERROR });
      return;
    }
    if (["bootstrapping", "ready", "idle"].includes(record.state)) {
      let cancellation = signal
        ? createWorkerProvisionCancellation(store, record, signal)
        : undefined;
      if (cancellation) {
        retainProviderSettlement?.(cancellation.settled);
      }
      try {
        cancellation?.assertActive();
        let installation = currentBundle;
        try {
          // Bundle identity is local and canonical for both install channels. A matching admitted
          // receipt must not depend on npm registry availability during routine reconciliation.
          installation ??= await options.prepareInstallation("bundle", workSignal);
        } catch (error) {
          workSignal.throwIfAborted();
          if (record.bootstrapReceipt && ["ready", "idle"].includes(record.state)) {
            await saveError(record, error);
            return;
          }
          await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
          return;
        }
        if (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, installation)) {
          await ensurePendingCredential(record, null);
          return;
        }
        if (check.requireInstall(record) === "npm") {
          try {
            installation = await options.prepareInstallation("npm", workSignal);
          } catch (error) {
            workSignal.throwIfAborted();
            await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
            return;
          }
        }
        record = await stopOwner(record);
        cancellation?.assertActive();
        const bootstrapping =
          record.state === "bootstrapping" ? record : await move(record, "bootstrapping");
        if (cancellation && bootstrapping.ownerEpoch !== record.ownerEpoch) {
          // Rebootstrap retires the admitted owner. Transfer cancellation synchronously
          // to the committed epoch before a child can run under that new authority.
          await cancellation.close();
          cancellation = createWorkerProvisionCancellation(
            store,
            bootstrapping,
            cancellation.signal,
          );
          retainProviderSettlement?.(cancellation.settled);
          cancellation.assertActive();
        }
        await finishBootstrap(bootstrapping, provider, installation, cancellation).catch(
          () => undefined,
        );
        return;
      } finally {
        await cancellation?.close();
      }
    }
    if (["draining", "destroying"].includes(record.state)) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const { createWithProfile, prepareIntent, prepareRetention, assertPreparedIntentCurrent } =
    createWorkerProviderIntent({
      ...options,
      providerFor,
      resumeProvision,
    });

  return {
    inspectTurnLease: leaseInspection.inspectTurnLease,
    readStartStatus: (record: WorkerEnvironmentRecord) => {
      const entry = startStatuses.get(record.environmentId);
      return record.state === "provisioning" && entry?.ownerEpoch === record.ownerEpoch
        ? entry.status
        : undefined;
    },
    getDedicatedNodeLeaseSignal: dedicatedLeases.signal,
    clearDedicatedNodeLeases: () => dedicatedLeases.clear(),
    createWithProfile,
    prepareIntent,
    prepareRetention,
    assertPreparedIntentCurrent,
    resumePrepared: createPreparedWorkerRecovery({
      ...options,
      expirePrepared,
      finishDestroy,
      reconcileRecord,
    }),
    destroy,
    reclaim,
    identityResolverFor,
    ...machineCatalog,
    providerFor,
    reconcileRecord,
    readRuntimeRefresh: runtimeRefresher.read,
    ensureRetainedRunning: retained.ensureRetainedRunning,
    suspendRetained: retained.suspendRetained,
  };
}
