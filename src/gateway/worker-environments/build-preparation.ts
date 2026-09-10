import { randomUUID } from "node:crypto";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode } from "../../plugins/types.js";
import type { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireWorkerProfile } from "./service-validation.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

type BuildPreparationOptions = Pick<
  WorkerProviderLifecycleInputOptions,
  "getConfig" | "resolveProvider" | "projectNamespace" | "store"
> & {
  providerLifecycle: Pick<
    ReturnType<typeof createWorkerProviderLifecycle>,
    "prepareIntent" | "assertPreparedIntentCurrent" | "providerFor"
  >;
  signal: AbortSignal;
  now: () => number;
  configuredProfileProviderId: (profileId: string) => string;
  requireProviderExecutionMode: (providerId: string, mode: WorkerExecutionMode) => void;
  schedulePreparedRefill: () => void;
  serviceError: (
    code:
      | "profile_not_found"
      | "invalid_profile"
      | "invalid_project"
      | "invalid_state"
      | "capacity",
    message: string,
  ) => Error;
};

export function createWorkerEnvironmentBuildPreparation(options: BuildPreparationOptions) {
  return async (request: { profileId: string; projectPath: string }, authorize?: () => void) => {
    const {
      signal,
      providerLifecycle,
      now,
      store,
      serviceError,
      configuredProfileProviderId,
      requireProviderExecutionMode,
      schedulePreparedRefill,
    } = options;
    signal.throwIfAborted();
    authorize?.();
    const { profileId, projectPath } = request;
    const providerId = configuredProfileProviderId(profileId);
    const provider = options.resolveProvider(
      normalizeCapabilityProviderId(providerId) ?? providerId,
    );
    const profile = options.getConfig().cloudWorkers!.profiles![profileId]!;
    if (
      !provider?.supportsProjectPreparation?.(
        requireWorkerProfile(profile.settings ?? {}, serviceError),
      )
    ) {
      throw serviceError("invalid_profile", "Worker profile does not support project preparation");
    }
    const namespace = options.projectNamespace;
    if (!namespace) {
      throw serviceError("invalid_state", "Worker project preparation namespace is unavailable");
    }
    let project: Awaited<ReturnType<typeof prepareWorkerProjectSnapshot>>;
    try {
      if (!projectPath.trim()) {
        throw new Error("Empty project path");
      }
      project = await prepareWorkerProjectSnapshot({
        localPath: projectPath,
        namespace,
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw serviceError(
        "invalid_project",
        "Project must be an accessible local Git checkout root with a HEAD commit",
      );
    }
    if (!project) {
      throw serviceError(
        "invalid_project",
        "Project must be an accessible local Git checkout root with a HEAD commit",
      );
    }
    authorize?.();
    // Placement consumption requires a concrete mode on the durable record.
    const executionMode = provider.supportedExecutionModes?.includes("worker-turn")
      ? "worker-turn"
      : "remote-exec";
    const intent = await providerLifecycle.prepareIntent(profileId, {
      projectPath: project.root,
      projectCommit: project.baseCommit,
      executionMode,
      setupAuthorized: true,
      signal,
    });
    signal.throwIfAborted();
    authorize?.();
    providerLifecycle.assertPreparedIntentCurrent(profileId, intent);
    requireProviderExecutionMode(intent.providerId, executionMode);
    const timeout = providerLifecycle
      .providerFor(intent.providerId)
      .resolvePreparedIdleTimeoutMs?.(
        requireWorkerProfile(intent.profileSnapshot.settings, serviceError),
      );
    if (!intent.preparationKey || !Number.isSafeInteger(timeout) || !timeout || timeout <= 0) {
      throw serviceError(
        "invalid_profile",
        "Worker profile does not support prepared workers with an idle timeout",
      );
    }
    const demandAtMs = now();
    const identity = deriveEnvironmentIntent(`prepared:${randomUUID()}`);
    const record = store.ensurePreparedIntent({
      intent: {
        ...identity,
        providerId: intent.providerId,
        profileId,
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose: "build",
          key: intent.preparationKey,
          demandAtMs,
          expiresAtMs: demandAtMs + timeout,
        },
      },
      projectKey: project.key,
      target: profile.readyWorkers ?? 1,
      maxTotal: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? 4,
      assertCurrent: () => {
        signal.throwIfAborted();
        authorize?.();
        providerLifecycle.assertPreparedIntentCurrent(profileId, intent);
      },
    });
    if (!record) {
      throw serviceError(
        "capacity",
        "Prepared worker pool is full; destroy an unused worker or wait for cleanup, then retry",
      );
    }
    schedulePreparedRefill();
    return {
      environmentId: record.environmentId,
      preparationKey: intent.preparationKey,
      reused: record.environmentId !== identity.environmentId,
    };
  };
}
