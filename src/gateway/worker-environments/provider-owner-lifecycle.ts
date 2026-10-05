import { isDeepStrictEqual } from "node:util";
import { WorkerProviderError, type WorkerProvider } from "../../plugins/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import {
  hasForcedWorkerEnvironmentAbandonment,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import {
  findActiveWorkerRecoveryHold,
  type WorkerEnvironmentRecoveryHold,
  type WorkerEnvironmentPreparedRecoveryHold,
} from "./environment-record.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import {
  destroyWorkerProviderLease,
  finishConfirmedProvisionCleanup,
  preserveIndeterminateProvisionCleanup,
} from "./provider-lease-destroy.js";
import type {
  WorkerEnvironmentAbandonment,
  WorkerProviderLifecycleOptions,
} from "./provider-lifecycle.types.js";
import { createWorkerSshIdentityResolver } from "./provider-ssh-identity.js";
import {
  requireWorkerAllocation,
  requireWorkerProfile,
  resolveWorkerLeaseTransportError,
} from "./service-validation.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";

// Resource attestation permits ten minutes plus child-process settlement.
const FAILED_LEASE_HOLD_CALL_TIMEOUT_MS = 10 * 60_000 + 10_000;

export function createWorkerProviderOwnerLifecycle(
  options: Pick<
    WorkerProviderLifecycleOptions,
    | "store"
    | "now"
    | "resolveProvider"
    | "getConfig"
    | "tunnelManager"
    | "callProvider"
    | "providerCallTimeoutMs"
    | "resolveSshIdentity"
    | "placementStore"
    | "move"
    | "retireNodeEnrollment"
    | "saveError"
    | "withLock"
    | "isStopping"
  > & {
    providerFor: (providerId: string) => WorkerProvider;
    onOwnerStopped?: (environmentId: string) => void;
  },
) {
  const { store, move, callProvider, saveError, withLock, providerFor } = options;
  const tunnels = options.tunnelManager;

  const lifecycleLease = (record: WorkerEnvironmentRecord, leaseId: string) => ({
    leaseId,
    profile: requireWorkerProfile(record.profileSnapshot.settings),
  });

  const requireCurrentOwner = (record: WorkerEnvironmentRecord): WorkerEnvironmentRecord => {
    const current = store.get(record.environmentId);
    if (
      !current ||
      current.ownerEpoch !== record.ownerEpoch ||
      current.state !== record.state ||
      current.leaseId !== record.leaseId ||
      current.nodeDeviceId !== record.nodeDeviceId ||
      current.sharedHost !== record.sharedHost ||
      !isDeepStrictEqual(current.recoveryHold, record.recoveryHold) ||
      !isDeepStrictEqual(current.attachedSessionIds, record.attachedSessionIds)
    ) {
      throw serviceError("invalid_state", "Worker environment owner changed during teardown");
    }
    return current;
  };

  const identityResolverFor = createWorkerSshIdentityResolver(options, requireCurrentOwner);

  const stopOwner = async (
    record: WorkerEnvironmentRecord,
    reason?: WorkerTunnelStopReason,
    runtimeRefresh?: { assertCurrent: () => void },
  ): Promise<WorkerEnvironmentRecord> => {
    requireCurrentOwner(record);
    runtimeRefresh?.assertCurrent();
    options.onOwnerStopped?.(record.environmentId);
    const sessionId = record.attachedSessionIds.length === 1 ? record.attachedSessionIds[0] : null;
    if (sessionId && !runtimeRefresh) {
      // Runtime refresh hands off eligible results before capturing placement authority.
      // Other revocations transfer custody before making the old process unreachable.
      await options.placementStore?.prepareWorkspaceResultOwnerRevocation(
        { sessionId, environmentId: record.environmentId, ownerEpoch: record.ownerEpoch },
        new Error(record.lastError ?? "Cloud worker owner revoked before workspace recovery"),
        () => {
          requireCurrentOwner(record);
        },
      );
      requireCurrentOwner(record);
    }
    // Fence admission without erasing the attachment needed to stop a retained node worker.
    // A crash or failed stop leaves the exact scope available for teardown replay.
    // The fence flag aborts in-flight workspace transfers immediately, before the tunnel
    // stop completes; revocations that are followed by a re-mint (rotation) never fence.
    await store.revokeEnvironmentCredential(record.environmentId, {
      fenceWorkspaceTransfers: true,
      expectedOwnerEpoch: record.ownerEpoch,
      assertCurrent: () => {
        requireCurrentOwner(record);
        runtimeRefresh?.assertCurrent();
      },
    });
    requireCurrentOwner(record);
    runtimeRefresh?.assertCurrent();
    // Only a dedicated node lease makes provider teardown proof of worker termination.
    // Shared or unknown host isolation still requires the exact worker's stop acknowledgement.
    await tunnels?.stop(
      record.environmentId,
      record.ownerEpoch,
      record.nodeDeviceId !== null && record.sharedHost === false ? reason : undefined,
    );
    return requireCurrentOwner(record);
  };

  const destroyLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    lease: Parameters<WorkerProvider["destroy"]>[0],
  ) =>
    destroyWorkerProviderLease({
      store,
      callProvider: options.callProvider,
      providerCallTimeoutMs: options.providerCallTimeoutMs,
      record,
      provider,
      lease,
      requireCurrentOwner,
    });

  const beginDrain = async (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    return ["bootstrapping", "ready", "attached", "idle"].includes(record.state)
      ? move(record, "draining", failurePatch)
      : record;
  };

  const beginDestroy = async (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    const draining = await beginDrain(record);
    if (draining.state === "draining") {
      return move(draining, "destroying", failurePatch);
    }
    if (draining.state === "destroying") {
      return draining;
    }
    throw serviceError("invalid_state", `Cannot destroy worker in state: ${record.state}`);
  };

  const finishProvenDestroy = async (record: WorkerEnvironmentRecord) => {
    const destroying = await beginDestroy(requireCurrentOwner(record));
    if (destroying.nodeSetupId) {
      await options.retireNodeEnrollment?.(destroying);
    }
    requireCurrentOwner(destroying);
    if (destroying.teardownTerminalState !== "failed") {
      return move(
        destroying,
        "destroyed",
        destroying.recoveryHold ? { lastError: destroying.lastError } : undefined,
      );
    }
    return move(destroying, "failed", {
      leaseId: null,
      nodeDeviceId: null,
      sshEndpoint: null,
      sharedHost: false,
      lastError: destroying.lastError ?? "Worker bootstrap failed after provider teardown",
    });
  };

  const failBootstrap = async (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
    leasePatch?: TransitionPatch,
    failureCode: "bootstrap_failure" | "invalid_profile" = "bootstrap_failure",
  ): Promise<never> => {
    const detail = boundedWorkerError(error);
    const failureLabel =
      failureCode === "invalid_profile"
        ? "Worker provider returned an incompatible lease"
        : leasePatch?.nodeDeviceId
          ? "Worker node bootstrap failed"
          : "Worker bootstrap failed";
    const requested = await store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const stopped = await stopOwner(requested);
    const draining = await move(stopped, "draining", { ...leasePatch, lastError: detail });
    const destroying = await beginDestroy(draining);
    try {
      await destroyLease(destroying, provider, lifecycleLease(destroying, leaseId));
    } catch (cleanupError: unknown) {
      // An indeterminate destroy must remain retryable; never hide a possibly-live paid lease
      // behind terminal failed state.
      await saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedWorkerError(cleanupError)}`),
      );
      throw serviceError(failureCode, `${failureLabel}; teardown is pending: ${detail}`);
    }
    await finishProvenDestroy(destroying);
    throw serviceError(failureCode, `${failureLabel}: ${detail}`);
  };

  const finishDestroy = async (record: WorkerEnvironmentRecord, provider?: WorkerProvider) => {
    let r = record.recoveryHold
      ? await store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          assertCurrent: () => {
            requireCurrentOwner(record);
          },
        })
      : record;
    if (r.state === "requested") {
      return move(requireCurrentOwner(r), "failed", {
        lastError: "Provisioning canceled before provider allocation",
      });
    }
    // Fence local authority even when the provider is unavailable. stopOwner preserves
    // shared/unknown-host stop acknowledgements before releasing their attachments.
    r = await stopOwner(r, "provider-destroying");
    r = r.nodeDeviceId !== null && r.sharedHost === false ? r : await beginDrain(r);
    const owningProvider = provider ?? providerFor(r.providerId);
    let leaseId = r.leaseId;
    if (!leaseId) {
      let allocation: Awaited<ReturnType<WorkerProvider["resolveAllocation"]>>;
      try {
        allocation = requireWorkerAllocation(
          await callProvider(r.environmentId, () => {
            requireCurrentOwner(r);
            return owningProvider.resolveAllocation(
              requireWorkerProfile(r.profileSnapshot.settings),
              r.provisionOperationId,
            );
          }),
        );
      } catch (error) {
        await saveError(requireCurrentOwner(r), error);
        throw serviceError("provider_failure", boundedWorkerError(error));
      }
      // Publish only the cleanup identity, never a fabricated transport or admission receipt.
      r = await move(requireCurrentOwner(r), "draining", { ...allocation, lastError: r.lastError });
      leaseId = allocation.leaseId;
    }
    // A dedicated provider's destroy result proves physical teardown even if its node is
    // offline. Shared hosts retain the machine, so they still require the exact worker stop.
    const providerOwnsMachine = r.nodeDeviceId !== null && r.sharedHost === false;
    let destroying = providerOwnsMachine ? r : await beginDestroy(r);
    try {
      destroying = await destroyLease(
        destroying,
        owningProvider,
        lifecycleLease(destroying, leaseId),
      );
    } catch (error) {
      await saveError(requireCurrentOwner(destroying), error);
      throw serviceError("provider_failure", boundedWorkerError(error));
    }
    return await finishProvenDestroy(
      providerOwnsMachine ? await stopOwner(destroying, "provider-destroyed") : destroying,
    );
  };

  const destroy = async (
    environmentId: string,
    destroyOptions: {
      requireUnattached?: boolean;
      abandonment?: WorkerEnvironmentAbandonment;
      forceAbandon?: () => Promise<void>;
      retryRequested?: boolean;
    } = {},
  ) => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(environmentId, async () => {
      await store.ready();
      const abandonment = destroyOptions.abandonment;
      abandonment?.authorize?.();
      let record = store.get(environmentId);
      if (!record) {
        await destroyOptions.forceAbandon?.();
        throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
      }
      if (record.recoveryHold) {
        return record.state === "destroyed" ? record : await finishDestroy(record);
      }
      if (
        ["destroyed", "failed", "orphaned"].includes(record.state) &&
        (!abandonment ||
          record.state === "destroyed" ||
          (record.state === "failed" && !record.leaseId))
      ) {
        await destroyOptions.forceAbandon?.();
        return record;
      }
      if (
        abandonment &&
        (record.providerId !== DEVICE_WORKER_PROVIDER_ID ||
          record.ownerEpoch !== abandonment.ownerEpoch ||
          !record.nodeDeviceId ||
          record.sharedHost === false ||
          record.attachedSessionIds.length !== 1 ||
          record.attachedSessionIds[0] !== abandonment.sessionId)
      ) {
        throw serviceError(
          "invalid_state",
          "Abandoned device worker owner changed before retirement",
        );
      }
      if (destroyOptions.requireUnattached && record.attachedSessionIds.length > 0) {
        throw serviceError(
          "invalid_state",
          "Attached cloud workers must be stopped through sessions.reclaim",
        );
      }
      // Environment reconciliation owns retries of accepted cleanup. A background
      // placement projection must not replay its failed provider call or claim success.
      if (destroyOptions.retryRequested === false && record.destroyRequestedAtMs !== null) {
        throw serviceError(
          "invalid_state",
          `Worker environment cleanup is still pending: ${record.lastError ?? record.state}`,
        );
      }
      const destroyOwner = record;
      const assertDestroyOwner = () => {
        abandonment?.authorize?.();
        const current = requireCurrentOwner(destroyOwner);
        if (destroyOptions.requireUnattached && current.attachedSessionIds.length > 0) {
          throw serviceError(
            "invalid_state",
            "Attached cloud workers must be stopped through sessions.reclaim",
          );
        }
      };
      record = await store.requestDestroy({
        environmentId,
        state: record.state,
        assertCurrent: assertDestroyOwner,
        ...(abandonment ? { terminalState: "failed" } : {}),
        ...(abandonment || destroyOptions.forceAbandon
          ? { lastError: FORCED_WORKER_ABANDONMENT_ERROR }
          : {}),
      });
      if (destroyOptions.forceAbandon && !hasForcedWorkerEnvironmentAbandonment(record)) {
        record = await store.recordError({
          environmentId,
          state: record.state,
          error: FORCED_WORKER_ABANDONMENT_ERROR,
          assertCurrent: assertDestroyOwner,
        });
      }
      // Persist the operator's discard decision before placement draining can survive a crash.
      await destroyOptions.forceAbandon?.();
      try {
        const destroyed = await finishDestroy(record);
        abandonment?.authorize?.();
        return destroyed;
      } catch (error) {
        if (!abandonment || !(error instanceof WorkerTunnelOwnerDisconnectedError)) {
          throw error;
        }
        abandonment.authorize?.();
        const current = requireCurrentOwner(record);
        if (current.destroyRequestedAtMs === null || store.getCredential(environmentId)) {
          throw serviceError("invalid_state", "Abandoned device worker authority is not fenced");
        }
        // Local cleanup has joined. Keep the exact old attachment for a physical stop on
        // reconnect; explicit abandonment releases only the session's local owner.
        return saveError(current, error);
      }
    });
  };

  const retireMismatchedLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
  ): Promise<boolean> => {
    const transport = record.nodeDeviceId ? "node" : record.sshEndpoint ? "ssh" : undefined;
    const modeError = transport
      ? resolveWorkerLeaseTransportError(provider, transport, record.profileSnapshot.executionMode)
      : undefined;
    if (!modeError || record.destroyRequestedAtMs !== null) {
      return false;
    }
    const requested = await store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: modeError.message,
    });
    await finishDestroy(requested, provider).catch(() => undefined);
    return true;
  };
  const holdFailedEnvironment = async (
    identity: Omit<WorkerEnvironmentRecoveryHold, "receipt" | "createdAtMs" | "leaseId" | "phase">,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) =>
    withLock(identity.environmentId, async () => {
      await store.ready();
      assertCurrent();
      signal?.throwIfAborted();
      const initial = store.get(identity.environmentId);
      if (
        !initial ||
        !initial.leaseId ||
        initial.ownerEpoch !== identity.ownerEpoch ||
        initial.sharedHost !== false
      ) {
        throw serviceError(
          "invalid_state",
          "Failed worker recovery requires its exact dedicated lease",
        );
      }
      const leaseId = initial.leaseId;
      if (initial.recoveryHold) {
        if (
          initial.recoveryHold.sessionId !== identity.sessionId ||
          initial.recoveryHold.placementGeneration !== identity.placementGeneration
        ) {
          throw serviceError("invalid_state", "Retained worker belongs to a different placement");
        }
        if (initial.recoveryHold.phase !== "requested") {
          return initial;
        }
      }
      const previous = findActiveWorkerRecoveryHold(store.list(), identity.sessionId);
      if (previous && previous.environmentId !== initial.environmentId) {
        throw serviceError(
          "invalid_state",
          "This session already has an unresolved retained worker; salvage it before another replacement",
        );
      }
      const provider = providerFor(initial.providerId);
      const hold = provider.holdFailedLease;
      if (!hold) {
        throw serviceError(
          "provider_failure",
          "This provider cannot retain a failed worker safely",
        );
      }
      let owned: WorkerEnvironmentRecord = initial;
      const check = () => {
        assertCurrent();
        signal?.throwIfAborted();
        requireCurrentOwner(owned);
      };
      const capacity = Math.max(1, options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? 3);
      // Custody, cleanup fencing, and credential revocation share one commit. A
      // capacity refusal must not leave the source newly eligible for destruction.
      owned = await store.retainFailedEnvironment({
        ...identity,
        leaseId,
        phase: "requested",
        createdAtMs: (options.now ?? Date.now)(),
        capacity,
        assertCurrent: check,
      });
      check();
      // Retire local transports without depending on an absent node acknowledging a stop.
      options.onOwnerStopped?.(owned.environmentId);
      await tunnels?.stop(owned.environmentId, owned.ownerEpoch, "provider-destroying");
      check();
      const lease = lifecycleLease(owned, leaseId);
      let receipt: Awaited<ReturnType<typeof hold>>;
      try {
        receipt = await callProvider(
          owned.environmentId,
          async () => {
            check();
            const allocation = await provider.resolveAllocation(
              lease.profile,
              initial.provisionOperationId,
            );
            check();
            if (allocation.leaseId !== leaseId) {
              throw serviceError("provider_failure", "Original hold allocation identity changed");
            }
            return hold(
              { ...lease, operationId: initial.provisionOperationId },
              { assertCurrent: check, signal },
            );
          },
          FAILED_LEASE_HOLD_CALL_TIMEOUT_MS,
        );
      } catch (error) {
        check();
        const recorded = await saveError(requireCurrentOwner(owned), error);
        check();
        return recorded;
      }
      check();
      if (
        receipt.status !== "held" ||
        receipt.leaseId !== leaseId ||
        receipt.unacceptedChanges !== "unknown" ||
        !Array.isArray(receipt.resources) ||
        receipt.resources.length === 0 ||
        receipt.resources.length > 16 ||
        receipt.resources.some(
          (resource) =>
            !resource.id ||
            !resource.kind ||
            (resource.state !== "absent" && resource.state !== "retained") ||
            (resource.state === "retained" && !resource.immutableId),
        )
      ) {
        throw serviceError(
          "provider_failure",
          "Provider did not attest the exact retained lease and resources",
        );
      }
      return await store.retainFailedEnvironment({
        ...identity,
        leaseId,
        receipt,
        phase: "held",
        createdAtMs: (options.now ?? Date.now)(),
        capacity,
        assertCurrent: check,
      });
    });

  const holdPreparedEnvironment = async (
    initial: WorkerEnvironmentRecord,
    signal?: AbortSignal,
  ) => {
    const hold = providerFor(initial.providerId).holdFailedLease;
    if (!hold || !initial.leaseId || !initial.preparation) {
      throw serviceError("invalid_state", "Prepared worker hold capability is unavailable");
    }
    let owned: WorkerEnvironmentRecord = initial;
    const check = () => {
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker service is stopping");
      }
      requireCurrentOwner(owned);
    };
    check();
    const input: WorkerEnvironmentPreparedRecoveryHold & { capacity: number } = {
      kind: "prepared",
      environmentId: initial.environmentId,
      ownerEpoch: initial.ownerEpoch,
      preparationKey: initial.preparation.key,
      leaseId: initial.leaseId,
      phase: "requested",
      createdAtMs: options.now?.() ?? Date.now(),
      capacity: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? 4,
    };
    try {
      owned = await store.retainPreparedEnvironment({ ...input, assertCurrent: check });
    } catch (error) {
      check();
      // Only the transaction's definite capacity refusal precedes custody/provider effects.
      // Exact teardown still needs provider proof; an uncertain hold never takes this path.
      if (error instanceof Error && "code" in error && error.code === "capacity") {
        return await finishDestroy(owned);
      }
      throw error;
    }
    check();
    if (owned.recoveryHold?.phase === "held") {
      return owned;
    }
    options.onOwnerStopped?.(owned.environmentId);
    await tunnels?.stop(owned.environmentId, owned.ownerEpoch, "provider-destroying");
    check();
    const receipt = await callProvider(
      owned.environmentId,
      () => {
        check();
        return hold(lifecycleLease(owned, input.leaseId), { assertCurrent: check, signal });
      },
      FAILED_LEASE_HOLD_CALL_TIMEOUT_MS,
    );
    check();
    if (
      receipt.status !== "held" ||
      receipt.leaseId !== input.leaseId ||
      receipt.unacceptedChanges !== "unknown" ||
      !Array.isArray(receipt.resources) ||
      receipt.resources.length === 0 ||
      receipt.resources.length > 16 ||
      !receipt.resources.some(
        (resource) => resource.kind === "vm" && resource.state === "absent",
      ) ||
      receipt.resources.some(
        (resource) =>
          !resource.id ||
          !resource.kind ||
          (resource.state !== "absent" && resource.state !== "retained") ||
          (resource.state === "retained" && !resource.immutableId),
      )
    ) {
      throw serviceError(
        "provider_failure",
        "Provider did not attest the exact retained prepared lease and resources",
      );
    }
    return store.retainPreparedEnvironment({
      ...input,
      phase: "held",
      receipt,
      assertCurrent: check,
    });
  };
  const reconcileRecoveryHold = async (
    record: WorkerEnvironmentRecord,
    status: Awaited<ReturnType<WorkerProvider["inspect"]>>["status"] | undefined,
    signal?: AbortSignal,
  ) => {
    if (
      record.recoveryHold?.diagnostic &&
      (record.recoveryHold.phase !== "requested" || record.recoveryHold.kind === "prepared")
    ) {
      if (record.state !== "destroyed") {
        await finishDestroy(record).catch(() => undefined);
      }
      return true;
    }
    if (record.recoveryHold?.kind === "prepared" && record.recoveryHold.phase === "held") {
      return true;
    }
    if (
      (status !== "unknown" && status !== undefined) ||
      record.destroyRequestedAtMs === null ||
      record.preparation?.purpose !== "reserve" ||
      record.preparation.consumedAtMs !== null ||
      record.sharedHost !== false ||
      record.attachedSessionIds.length !== 0 ||
      !providerFor(record.providerId).holdFailedLease ||
      providerFor(record.providerId).supportsFailedLeaseHold?.(
        requireWorkerProfile(record.profileSnapshot.settings),
      ) === false
    ) {
      return false;
    }
    await holdPreparedEnvironment(record, signal).catch((error: unknown) =>
      saveError(store.get(record.environmentId) ?? record, error),
    );
    return true;
  };
  const now = options.now ?? Date.now;
  return {
    expirePrepared: async (record: WorkerEnvironmentRecord) =>
      !record.recoveryHold &&
      record.preparation?.consumedAtMs === null &&
      record.preparation.expiresAtMs <= now()
        ? store.requestDestroy({
            environmentId: record.environmentId,
            state: record.state,
            lastError: "Unused prepared worker expired",
            assertCurrent: () => {
              requireCurrentOwner(record);
            },
          })
        : record,
    supportsFailedLeaseHold: (environmentId: string) => {
      const record = store.get(environmentId);
      if (!record) {
        return false;
      }
      const provider = options.resolveProvider(record.providerId);
      return (
        provider !== undefined &&
        provider.holdFailedLease !== undefined &&
        provider.supportsFailedLeaseHold?.(
          requireWorkerProfile(record.profileSnapshot.settings),
        ) !== false
      );
    },
    holdFailedEnvironment,
    reconcileRecoveryHold,
    identityResolverFor,
    requireCurrentOwner,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    failBootstrap,
    finishConfirmedProvisionCleanup: (
      record: WorkerEnvironmentRecord,
      error: ReturnType<typeof WorkerProviderError.cleanupComplete>,
      assertCurrent?: () => void,
    ) =>
      finishConfirmedProvisionCleanup(
        record,
        error,
        { store, stopOwner, finishProvenDestroy },
        assertCurrent,
      ),
    preserveIndeterminateProvisionCleanup: (
      record: WorkerEnvironmentRecord,
      error: ReturnType<typeof WorkerProviderError.cleanupIndeterminate>,
    ) => preserveIndeterminateProvisionCleanup(record, error, store),
    destroy,
    retireMismatchedLease,
  };
}
