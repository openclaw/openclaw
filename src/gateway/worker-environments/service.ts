import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProfile,
  type WorkerProvider,
  type WorkerSshEndpoint,
} from "../../plugins/types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { WorkerEnvironmentState } from "./state.js";
import {
  normalizeWorkerSshEndpoint,
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
  type WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";

export type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_state"
  | "provider_failure";

export class WorkerEnvironmentServiceError extends Error {
  constructor(
    readonly code: WorkerEnvironmentServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const serviceError = (code: WorkerEnvironmentServiceErrorCode, message: string) =>
  new WorkerEnvironmentServiceError(code, message);

export type WorkerEnvironmentServiceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  reconcileIntervalMs?: number;
  providerCallTimeoutMs?: number;
  logger?: { warn: (message: string) => void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireWorkerProfile(value: unknown): WorkerProfile {
  const error = validateCloudWorkerProfileSettings(value);
  if (error) {
    throw serviceError("invalid_profile", error);
  }
  return value as WorkerProfile;
}

function inspectionStatus(value: unknown): WorkerLeaseStatus["status"] {
  if (!isRecord(value)) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  const status = value.status;
  if (status !== "active" && status !== "destroyed" && status !== "unknown") {
    throw new Error("Worker provider returned an invalid inspection status");
  }
  return status;
}

function requireWorkerLease(value: unknown): WorkerLease {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    !isRecord(value.ssh)
  ) {
    throw new Error("Worker provider returned an invalid provision result");
  }
  return {
    leaseId: value.leaseId.trim(),
    ssh: normalizeWorkerSshEndpoint(value.ssh as WorkerSshEndpoint),
  };
}

function boundedError(error: unknown): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(redacted || "unknown error", 1_024);
}

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store } = options;
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  let reconcileInFlight: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const move = (r: WorkerEnvironmentRecord, to: WorkerEnvironmentState, patch?: TransitionPatch) =>
    store.transition({ environmentId: r.environmentId, from: r.state, to, patch });

  const saveError = (r: WorkerEnvironmentRecord, error: unknown) =>
    store.recordError({
      environmentId: r.environmentId,
      state: r.state,
      error: boundedError(error),
    });

  const inState = (r: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) =>
    states.includes(r.state);
  const withLock = <T>(environmentId: string, task: () => Promise<T>) => {
    const operation = operations.enqueue(environmentId, task);
    activeOperations.add(operation);
    const release = () => activeOperations.delete(operation);
    void operation.then(release, release);
    return operation;
  };

  const callProvider = <T>(run: () => Promise<T>) =>
    withTimeout(
      Promise.resolve().then(run),
      options.providerCallTimeoutMs ?? 300_000,
      "Worker provider operation",
    );

  const providerFor = (providerId: string): WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const finishProvision = async (record: WorkerEnvironmentRecord, provider: WorkerProvider) => {
    let lease: WorkerLease;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
      lease = requireWorkerLease(
        await callProvider(() => provider.provision(profile, record.provisionOperationId)),
      );
    } catch (error) {
      if (
        error instanceof WorkerProviderError ||
        (error instanceof WorkerEnvironmentServiceError && error.code === "invalid_profile")
      ) {
        move(record, "failed", { lastError: boundedError(error) });
        throw serviceError("invalid_profile", "Worker provider rejected profile");
      }
      saveError(record, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = { leaseId: lease.leaseId, sshEndpoint: lease.ssh };
    const bootstrapping = move(record, "bootstrapping", patch);
    // No bootstrap payload yet; this edge owns future bootstrap work.
    return record.destroyRequestedAtMs === null ? move(bootstrapping, "ready") : bootstrapping;
  };

  const resumeProvision = (r: WorkerEnvironmentRecord, provider = providerFor(r.providerId)) =>
    finishProvision(r.state === "requested" ? move(r, "provisioning") : r, provider);

  const cancelRequested = (record: WorkerEnvironmentRecord) =>
    move(record, "failed", { lastError: "Provisioning canceled before provider allocation" });

  const beginDestroy = (record: WorkerEnvironmentRecord) => {
    const draining = inState(record, "bootstrapping", "ready", "attached", "idle")
      ? move(record, "draining")
      : record;
    if (draining.state === "draining") {
      return move(draining, "destroying");
    }
    if (draining.state === "destroying") {
      return draining;
    }
    throw serviceError("invalid_state", `Cannot destroy worker in state: ${record.state}`);
  };

  const finishDestroy = async (r: WorkerEnvironmentRecord, provider: WorkerProvider) => {
    if (!r.leaseId) {
      throw serviceError("invalid_state", "Worker environment has no lease");
    }
    const leaseId = r.leaseId;
    const destroying = beginDestroy(r);
    try {
      await callProvider(() => provider.destroy(leaseId));
    } catch (error) {
      saveError(destroying, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    return move(destroying, "destroyed");
  };

  const reconcileRecord = async (record: WorkerEnvironmentRecord): Promise<void> => {
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void cancelRequested(record);
    }
    let provider: WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      const provisioned = await resumeProvision(record, provider).catch(() => undefined);
      if (provisioned?.state === "bootstrapping") {
        await finishDestroy(provisioned, provider).catch(() => undefined);
      }
      return;
    }
    const status = await callProvider(() => provider.inspect(leaseId))
      .then(inspectionStatus)
      .catch((error: unknown) => {
        saveError(record, error);
        return undefined;
      });
    if (!status) {
      return;
    }
    const teardownExpected =
      record.destroyRequestedAtMs !== null || inState(record, "draining", "destroying");
    if (status === "destroyed" || (status === "unknown" && teardownExpected)) {
      move(beginDestroy(record), "destroyed");
      return;
    }
    if (status === "unknown") {
      move(record, "orphaned", { lastError: "Worker provider no longer recognizes the lease" });
      return;
    }
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (record.state === "bootstrapping") {
      return void move(record, "ready");
    }
    if (inState(record, "draining", "destroying")) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const create = async (profileId: string, idempotencyKey: string) => {
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    const environmentId = `worker:${digest.slice(0, 32)}`;
    return withLock(environmentId, async () => {
      const existing = store.get(environmentId);
      if (existing) {
        if (existing.profileId !== normalizedProfileId) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && inState(existing, "requested", "provisioning")) {
          return resumeProvision(existing);
        }
        return existing;
      }
      const profiles = options.getConfig().cloudWorkers?.profiles;
      if (!profiles || !Object.hasOwn(profiles, normalizedProfileId)) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      const profile = profiles[normalizedProfileId];
      const provider = providerFor(profile.provider);
      const settings = requireWorkerProfile(profile.settings ?? {});
      const intent = store.createIntent({
        environmentId,
        providerId: normalizeCapabilityProviderId(provider.id) ?? provider.id,
        profileId: normalizedProfileId,
        profileSnapshot: requireWorkerProfile({
          settings,
          ...(profile.lifetime ? { lifetime: profile.lifetime } : {}),
        }),
        provisionOperationId: `provision:${digest}`,
      });
      return resumeProvision(intent, provider);
    });
  };

  const destroy = async (environmentId: string) =>
    withLock(environmentId, async () => {
      let record = store.get(environmentId);
      if (!record) {
        throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
      }
      if (inState(record, "destroyed", "failed", "orphaned")) {
        return record;
      }
      record = store.requestDestroy({ environmentId, state: record.state });
      if (record.state === "requested") {
        return cancelRequested(record);
      }
      if (record.leaseId) {
        record = beginDestroy(record);
      }
      const provider = providerFor(record.providerId);
      if (!record.leaseId) {
        record = await resumeProvision(record, provider);
      }
      return finishDestroy(record, provider);
    });

  const reconcilePass = async () => {
    const tasks = store.listForReconcile().map(
      (candidate) => () =>
        withLock(candidate.environmentId, async () => {
          const current = store.get(candidate.environmentId);
          if (!current || inState(current, "destroyed", "failed")) {
            return;
          }
          await reconcileRecord(current).catch(() =>
            warn(
              `Worker environment reconcile failed (${current.environmentId}, ${current.providerId})`,
            ),
          );
        }),
    );
    await runTasksWithConcurrency({ tasks, limit: 8 });
  };

  const reconcileOnce = () =>
    (reconcileInFlight ??= reconcilePass().finally(() => {
      reconcileInFlight = undefined;
    }));

  const start = () => {
    if (interval) {
      return;
    }
    interval = setInterval(
      () => void reconcileOnce().catch(() => warn("Worker environment reconcile sweep failed")),
      options.reconcileIntervalMs ?? 60_000,
    );
    interval.unref?.();
    void reconcileOnce().catch(() => warn("Worker environment startup reconcile failed"));
  };

  const stop = async () => {
    clearInterval(interval);
    interval = undefined;
    await reconcileInFlight;
    await Promise.allSettled(activeOperations);
  };

  return {
    list: store.list,
    get: store.get,
    create,
    destroy,
    reconcileOnce,
    start,
    stop,
  };
}

export type WorkerEnvironmentService = ReturnType<typeof createWorkerEnvironmentService>;
