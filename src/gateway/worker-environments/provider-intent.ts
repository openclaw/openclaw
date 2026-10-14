import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { resolveGitRepositoryPaths } from "../../agents/worktrees/git.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import {
  createWorkerPreparationIdentity,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import {
  readWorkerPreparation,
  readWorkerProjectPreparation,
} from "./preparation-identity.schema.js";
import {
  readWorkerProjectEnvironmentRecipe,
  readWorkerProjectSnapshot,
} from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import {
  requireInheritedWorkerProfileAuthorization,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { prepareWorkerProjectSnapshot, workerLocalProjectKey } from "./workspace-git-base.js";

type WorkerProviderIntentOptions = Pick<
  WorkerProviderLifecycleOptions,
  "store" | "getConfig" | "projectNamespace" | "prepareNodeArtifacts" | "isStopping" | "withLock"
> & {
  providerFor: (providerId: string) => WorkerProvider;
  resumeProvision: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
    signal?: AbortSignal,
  ) => Promise<WorkerEnvironmentRecord>;
};

export type WorkerProviderIntentPreparationOptions = {
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  projectCommit?: string;
  /** Refill only: the retained source already admitted an empty committed workspace. */
  emptyWorkspace?: true;
  repository?: { agentId: string; url: string; ref?: string; baseCommit?: string };
  projectRepository?: RepositoryWorkerProjectSnapshot;
  runSetupScript?: boolean;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
};

function allocationSnapshot(
  profile: WorkerProfile,
  { machineClass, os, executionMode }: WorkerProviderIntentPreparationOptions,
): WorkerProfile {
  // A new allocation admits its own project, even when it inherits provider settings.
  const { project: _project, runtimePreparation: _runtimePreparation, ...snapshot } = profile;
  return {
    ...snapshot,
    ...(machineClass === undefined ? {} : { machineClass }),
    ...(os === undefined ? {} : { os }),
    ...(executionMode === undefined ? {} : { executionMode }),
  };
}

function projectReplayIdentity(project: unknown): unknown {
  if (!isRecord(project)) {
    return project;
  }
  // Display metadata can change without changing the admitted preparation.
  const identity = { ...project };
  delete identity.label;
  // Local keys bind shared Git storage; a checkout path is only its transport location.
  if (!Object.hasOwn(identity, "source")) {
    delete identity.root;
  }
  return identity;
}

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const preparedIntents = new WeakMap<
    WorkerProviderPreparedIntent,
    { profileId: string; assertCurrent: () => void }
  >();
  const assertPreparedIntentCurrent = (profileId: string, intent: WorkerProviderPreparedIntent) => {
    const prepared = preparedIntents.get(intent);
    if (!prepared || prepared.profileId !== profileId) {
      throw serviceError("invalid_state", "Worker preparation is not owned by this lifecycle");
    }
    prepared.assertCurrent();
  };
  const { store, withLock, providerFor, resumeProvision } = options;
  const requireProfileId = (profileId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    return normalizedProfileId;
  };
  const resolveProfile = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
  ) => {
    const normalizedProfileId = requireProfileId(profileId, createOptions.signal);
    const { inherited } = createOptions;
    let provider: WorkerProvider;
    let providerId: string;
    let profileSnapshot: WorkerProfile;
    const profiles = options.getConfig().cloudWorkers?.profiles;
    const configuredProfile =
      profiles && Object.hasOwn(profiles, normalizedProfileId)
        ? profiles[normalizedProfileId]
        : undefined;
    if (inherited) {
      providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
      if (providerId !== inherited.providerId) {
        throw serviceError(
          "invalid_profile",
          "Inherited worker provider ID is not in the expected format",
        );
      }
      requireInheritedWorkerProfileAuthorization(
        normalizedProfileId,
        providerId,
        inherited.profileSnapshot.settings,
        configuredProfile?.provider,
      );
      provider = providerFor(providerId);
      const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      if (resolvedProviderId !== providerId) {
        throw serviceError("invalid_profile", "Inherited worker provider identity changed");
      }
      profileSnapshot = inherited.profileSnapshot;
    } else {
      if (!configuredProfile) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      provider = providerFor(configuredProfile.provider);
      providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      const settings = requireWorkerProfile(configuredProfile.settings ?? {});
      profileSnapshot = { install: configuredProfile.install ?? "bundle", settings };
    }
    return {
      provider,
      providerId,
      profileSnapshot: structuredClone(
        requireWorkerProfile(allocationSnapshot(profileSnapshot, createOptions)),
      ),
    };
  };

  const prepareIntent = async (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
  ): Promise<WorkerProviderPreparedIntent> => {
    const resolved = resolveProfile(profileId, createOptions);
    const { provider, providerId } = resolved;
    const { signal, projectPath } = createOptions;
    let profileSnapshot = resolved.profileSnapshot;
    const machineClass =
      typeof profileSnapshot.machineClass === "string" ? profileSnapshot.machineClass : undefined;
    const os = typeof profileSnapshot.os === "string" ? profileSnapshot.os : undefined;
    let repositoryAdmission:
      | Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>
      | undefined;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    if (
      [
        projectPath,
        createOptions.repository,
        createOptions.projectRepository,
        createOptions.emptyWorkspace,
      ].filter(Boolean).length > 1
    ) {
      throw serviceError(
        "invalid_profile",
        "Worker preparation must have exactly one project source",
      );
    }
    if (
      (projectPath ||
        createOptions.repository ||
        createOptions.projectRepository ||
        createOptions.emptyWorkspace) &&
      provider.supportsProjectPreparation?.(profile, machineClass, os)
    ) {
      if (!options.projectNamespace) {
        throw serviceError("invalid_state", "Worker project preparation namespace is unavailable");
      }
      if (createOptions.repository || createOptions.projectRepository) {
        repositoryAdmission = await prepareRepositoryWorkerProjectSource({
          ...(createOptions.projectRepository
            ? { expected: createOptions.projectRepository }
            : { repository: createOptions.repository! }),
          namespace: options.projectNamespace,
          getConfig: options.getConfig,
          assertCurrent: () => {
            requireProfileId(profileId, signal);
          },
          signal,
          knownRecipe: (admittedProject) => {
            for (const record of store.list()) {
              const value = record.profileSnapshot.project;
              if (
                !isRecord(value) ||
                value.key !== admittedProject.key ||
                value.baseCommit !== admittedProject.baseCommit
              ) {
                continue;
              }
              const cached = readWorkerProjectSnapshot(value);
              const preparation = readWorkerProjectPreparation(value);
              if (
                cached &&
                "source" in cached &&
                preparation &&
                preparation.recipe &&
                isDeepStrictEqual(cached, admittedProject)
              ) {
                return {
                  project: cached,
                  setupRecipe: preparation.setupRecipe,
                  recipe: preparation.recipe,
                };
              }
            }
            return undefined;
          },
        });
      }
      const project = createOptions.emptyWorkspace
        ? null
        : (repositoryAdmission?.project ??
          (projectPath
            ? await prepareWorkerProjectSnapshot({
                localPath: projectPath,
                namespace: options.projectNamespace,
                baseCommit: createOptions.projectCommit,
                signal,
              })
            : undefined));
      signal?.throwIfAborted();
      if (project !== undefined) {
        const target = provider.resolvePreparationTarget?.(profile, machineClass, os);
        const recipe =
          target && project
            ? "source" in project
              ? repositoryAdmission?.recipe
              : await readWorkerProjectEnvironmentRecipe(project, signal)
            : undefined;
        const setupRecipe = recipe?.identity;
        signal?.throwIfAborted();
        // An executable recipe does not authorize itself. Non-admin callers retain
        // ordinary checkout preparation without executing it or filling a reserve.
        if (
          target &&
          provider.requiresNodeEnrollment &&
          options.prepareNodeArtifacts &&
          (!setupRecipe ||
            createOptions.runSetupScript === false ||
            createOptions.setupAuthorized === true)
        ) {
          const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
          signal?.throwIfAborted();
          const preparation = createWorkerPreparationIdentity({
            namespace: options.projectNamespace,
            providerId,
            profileId,
            profileSnapshot,
            project: project ?? undefined,
            target,
            artifacts: prepared.artifacts,
            setupRecipe,
            recipe,
            runSetupScript: createOptions.runSetupScript,
          });
          profileSnapshot = project
            ? { ...profileSnapshot, project: { ...project, preparation } }
            : { ...profileSnapshot, runtimePreparation: { source: "empty", ...preparation } };
        } else if (project) {
          profileSnapshot = { ...profileSnapshot, project };
        }
      }
    }
    const preparation = readWorkerPreparation(profileSnapshot);
    const intent = {
      providerId,
      profileSnapshot,
      ...(preparation ? { preparationKey: preparation.key } : {}),
    };
    preparedIntents.set(intent, {
      profileId,
      // Private repository authority remains live; profile and plugin metadata
      // are the snapshot selected when preparation began.
      assertCurrent: () => repositoryAdmission?.assertCurrent(),
    });
    return intent;
  };

  // Retention checks immutable contents against local policy/runtime facts.
  // Unknown observations throw; only confirmed incompatibility returns undefined/false.
  // This closure cannot authorize an allocation or claim private source.
  const prepareRetention = async (
    record: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    onInvalid?: (reason: string) => void,
  ) => {
    const invalid = (reason: string) => {
      onInvalid?.(reason);
      return undefined;
    };
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    const preparation = readWorkerPreparation(record.profileSnapshot);
    if (!preparation || !options.prepareNodeArtifacts || !options.projectNamespace) {
      return invalid("preparation runtime is unavailable");
    }
    const createOptions: WorkerProviderIntentPreparationOptions = {
      machineClass:
        typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined,
      os: typeof record.profileSnapshot.os === "string" ? record.profileSnapshot.os : undefined,
      executionMode:
        record.profileSnapshot.executionMode === "worker-turn" ||
        record.profileSnapshot.executionMode === "remote-exec"
          ? record.profileSnapshot.executionMode
          : undefined,
      signal,
    };
    signal?.throwIfAborted();
    const config = options.getConfig();
    const configured = config.cloudWorkers?.profiles?.[record.profileId];
    if (
      !configured ||
      normalizeCapabilityProviderId(configured.provider) !== record.providerId ||
      !isDeepStrictEqual(
        allocationSnapshot(
          {
            install: configured.install ?? "bundle",
            settings: requireWorkerProfile(configured.settings ?? {}),
          },
          createOptions,
        ),
        allocationSnapshot(record.profileSnapshot, createOptions),
      )
    ) {
      return invalid("configured profile changed");
    }
    const isSourceOwnerCurrent = () => {
      const sourceConfig = options.getConfig();
      if (project && "source" in project) {
        const { agent, identity } = project.source.owner;
        const agentIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "agent",
        });
        const systemIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "system",
        });
        const selected = agentIdentity ?? systemIdentity;
        const selectedSource = agentIdentity ? "agent-override" : "system-configured";
        if (
          selected
            ? identity.source !== selectedSource ||
              !("profileId" in identity) ||
              identity.profileId !== selected.profileId
            : identity.source !== "anonymous" && identity.source !== "system-detected"
        ) {
          return false;
        }
      }
      return true;
    };
    if (!isSourceOwnerCurrent()) {
      return invalid("repository owner changed");
    }
    if (
      project &&
      "source" in project &&
      !(await matchesAgentLifecycleBindingAsync(options.getConfig, project.source.owner.agent))
    ) {
      return invalid("repository agent changed");
    }
    const resolved = resolveProfile(record.profileId, createOptions);
    const { provider, providerId, profileSnapshot } = resolved;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    const target = provider.resolvePreparationTarget?.(
      profile,
      createOptions.machineClass,
      createOptions.os,
    );
    if (
      providerId !== record.providerId ||
      !target ||
      !isDeepStrictEqual(target, preparation.target) ||
      !provider.requiresNodeEnrollment ||
      !provider.supportsProjectPreparation?.(profile, createOptions.machineClass, createOptions.os)
    ) {
      return invalid("provider preparation target changed");
    }
    const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
    const isCurrent = () =>
      isSourceOwnerCurrent() &&
      (!project ||
        !("source" in project) ||
        matchesAgentLifecycleBinding(options.getConfig(), project.source.owner.agent));
    if (!isCurrent()) {
      return invalid("repository owner changed during retention");
    }
    const observed = createWorkerPreparationIdentity({
      namespace: options.projectNamespace,
      providerId,
      profileId: record.profileId,
      profileSnapshot,
      project,
      target,
      artifacts: prepared.artifacts,
      setupRecipe: preparation.setupRecipe,
      recipe: preparation.recipe,
      runSetupScript: preparation.runSetupScript,
    });
    return isDeepStrictEqual(project ? observed : { source: "empty", ...observed }, preparation)
      ? { isCurrent }
      : invalid("runtime artifacts or preparation identity changed");
  };

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
    admittedIntent?: WorkerProviderPreparedIntent,
  ) => {
    const { machineClass, os, executionMode, projectPath, signal } = createOptions;
    const inherited = createOptions.inherited
      ? {
          providerId: createOptions.inherited.providerId,
          profileSnapshot: allocationSnapshot(
            createOptions.inherited.profileSnapshot,
            createOptions,
          ),
        }
      : undefined;
    const normalizedProfileId = requireProfileId(profileId, signal);
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      await store.ready();
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        const existingProject = readWorkerProjectSnapshot(existing.profileSnapshot.project);
        if (existingProject && projectPath) {
          if ("source" in existingProject) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (!options.projectNamespace) {
            throw serviceError(
              "invalid_state",
              "Worker project preparation namespace is unavailable",
            );
          }
          // Replay identifies the repository; it retains the already-admitted root and commit.
          const { commonDir } = await resolveGitRepositoryPaths(await fsp.realpath(projectPath), {
            signal,
          });
          signal?.throwIfAborted();
          if (workerLocalProjectKey(options.projectNamespace, commonDir) !== existingProject.key) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (
            createOptions.projectCommit !== undefined &&
            createOptions.projectCommit !== existingProject.baseCommit
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        const requested =
          admittedIntent ??
          (createOptions.repository || createOptions.projectRepository
            ? await prepareIntent(profileId, createOptions)
            : undefined);
        if (requested) {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, requested);
          if (
            !isDeepStrictEqual(
              projectReplayIdentity(existing.profileSnapshot.project),
              projectReplayIdentity(requested.profileSnapshot.project),
            ) ||
            !isDeepStrictEqual(
              existing.profileSnapshot.runtimePreparation,
              requested.profileSnapshot.runtimePreparation,
            )
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, {
                ...inherited.profileSnapshot,
                ...(existingProject ? { project: existing.profileSnapshot.project } : {}),
                ...(existing.profileSnapshot.runtimePreparation
                  ? { runtimePreparation: existing.profileSnapshot.runtimePreparation }
                  : {}),
              }))) ||
          (inherited === undefined &&
            (existing.profileSnapshot.machineClass !== machineClass ||
              existing.profileSnapshot.os !== os ||
              existing.profileSnapshot.executionMode !== executionMode))
        ) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && ["requested", "provisioning"].includes(existing.state)) {
          return resumeProvision(existing, undefined, signal);
        }
        return existing;
      }
      const admitted =
        admittedIntent ??
        (await prepareIntent(profileId, {
          ...createOptions,
          setupAuthorized:
            createOptions.setupAuthorized ?? createOptions.runSetupScript !== undefined,
        }));
      signal?.throwIfAborted();
      assertPreparedIntentCurrent(profileId, admitted);
      if (admitted.preparationKey !== readWorkerPreparation(admitted.profileSnapshot)?.key) {
        throw serviceError(
          "invalid_profile",
          "Prepared worker intent no longer matches its profile",
        );
      }
      const { providerId, profileSnapshot } = admitted;
      const provider = providerFor(providerId);
      const intent = await store.createIntent(
        {
          environmentId,
          providerId,
          profileId: normalizedProfileId,
          profileSnapshot,
          provisionOperationId,
        },
        () => {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, admitted);
        },
      );
      return resumeProvision(intent, provider, signal);
    });
  };
  return { prepareIntent, prepareRetention, assertPreparedIntentCurrent, createWithProfile };
}
