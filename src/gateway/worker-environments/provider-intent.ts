import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { matchesAgentLifecycleBinding } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import {
  createWorkerProjectPreparationIdentity,
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSetupRecipe, readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireInheritedWorkerProfileAuthorization } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

type WorkerProviderIntentOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "getConfig"
  | "projectNamespace"
  | "prepareNodeArtifacts"
  | "isStopping"
  | "inState"
  | "withLock"
  | "serviceError"
> & {
  providerFor: (providerId: string) => WorkerProvider;
  requireWorkerProfile: (value: unknown) => WorkerProfile;
  resumeProvision: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
    signal?: AbortSignal,
  ) => Promise<WorkerEnvironmentRecord>;
};

type WorkerProviderIntentPreparationOptions = {
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  projectCommit?: string;
  repository?: { agentId: string; url: string; ref?: string; baseCommit?: string };
  projectRepository?: RepositoryWorkerProjectSnapshot;
  runSetupScript?: boolean;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
};

function projectReplayIdentity(project: unknown): unknown {
  if (!isRecord(project)) {
    return project;
  }
  // Display metadata can change without changing the admitted preparation.
  const identity = { ...project };
  delete identity.label;
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
      throw options.serviceError(
        "invalid_state",
        "Worker preparation is not owned by this lifecycle",
      );
    }
    prepared.assertCurrent();
  };
  const {
    store,
    inState,
    serviceError,
    withLock,
    providerFor,
    requireWorkerProfile,
    resumeProvision,
  } = options;
  const resolveProfile = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
  ) => {
    createOptions.signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const { machineClass, os, executionMode } = createOptions;
    const inherited = createOptions.inherited
      ? {
          ...createOptions.inherited,
          profileSnapshot: { ...createOptions.inherited.profileSnapshot },
        }
      : undefined;
    if (inherited) {
      delete inherited.profileSnapshot.project;
    }
    const provisionSnapshot = {
      ...(machineClass === undefined ? {} : { machineClass }),
      ...(os === undefined ? {} : { os }),
      ...(executionMode === undefined ? {} : { executionMode }),
    };
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
        throw serviceError("invalid_profile", "Inherited worker provider id is not canonical");
      }
      requireInheritedWorkerProfileAuthorization(
        normalizedProfileId,
        providerId,
        inherited.profileSnapshot.settings,
        configuredProfile?.provider,
        serviceError,
      );
      provider = providerFor(providerId);
      const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      if (resolvedProviderId !== providerId) {
        throw serviceError("invalid_profile", "Inherited worker provider identity changed");
      }
      profileSnapshot = requireWorkerProfile({
        ...inherited.profileSnapshot,
        ...provisionSnapshot,
      });
    } else {
      if (!configuredProfile) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      provider = providerFor(configuredProfile.provider);
      providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      const settings = requireWorkerProfile(configuredProfile.settings ?? {});
      profileSnapshot = requireWorkerProfile({
        install: configuredProfile.install ?? "bundle",
        settings,
        ...provisionSnapshot,
      });
    }
    return { provider, providerId, profileSnapshot: structuredClone(profileSnapshot) };
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
    let assertArtifactsCurrent: (() => void) | undefined;
    let repositoryAdmission:
      | Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>
      | undefined;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    const profileOptions = {
      inherited: createOptions.inherited ? structuredClone(createOptions.inherited) : undefined,
      machineClass: createOptions.machineClass,
      os: createOptions.os,
      executionMode: createOptions.executionMode,
    };
    const assertProfileCurrent = () => {
      const current = resolveProfile(profileId, profileOptions);
      if (
        current.provider !== provider ||
        !isDeepStrictEqual(current.profileSnapshot, resolved.profileSnapshot)
      ) {
        throw serviceError("invalid_profile", "Worker profile changed during preparation");
      }
    };
    if (
      [projectPath, createOptions.repository, createOptions.projectRepository].filter(Boolean)
        .length > 1
    ) {
      throw serviceError(
        "invalid_profile",
        "Worker preparation must have exactly one project source",
      );
    }
    if (
      (projectPath || createOptions.repository || createOptions.projectRepository) &&
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
          assertCurrent: assertProfileCurrent,
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
                isDeepStrictEqual(cached, admittedProject)
              ) {
                return { project: cached, setupRecipe: preparation.setupRecipe };
              }
            }
            return undefined;
          },
        });
      }
      const project =
        repositoryAdmission?.project ??
        (projectPath
          ? await prepareWorkerProjectSnapshot({
              localPath: projectPath,
              namespace: options.projectNamespace,
              baseCommit: createOptions.projectCommit,
              signal,
            })
          : undefined);
      signal?.throwIfAborted();
      if (project) {
        const target = provider.resolvePreparationTarget?.(profile, machineClass, os);
        const setupRecipe = target
          ? "source" in project
            ? repositoryAdmission?.setupRecipe
            : await readWorkerProjectSetupRecipe(project, signal)
          : undefined;
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
          prepared.assertCurrent();
          assertArtifactsCurrent = prepared.assertCurrent;
          const preparation = createWorkerProjectPreparationIdentity({
            namespace: options.projectNamespace,
            providerId,
            profileId,
            profileSnapshot,
            project,
            target,
            artifacts: prepared.artifacts,
            setupRecipe,
            runSetupScript: createOptions.runSetupScript,
          });
          profileSnapshot = { ...profileSnapshot, project: { ...project, preparation } };
        } else {
          profileSnapshot = { ...profileSnapshot, project };
        }
      }
    }
    // Retain only process-stable profile/artifact observations, never the caller's
    // abort or authorization closure. Dispatch revalidates its own live authority.
    const assertCurrent = () => {
      assertProfileCurrent();
      assertArtifactsCurrent?.();
      repositoryAdmission?.assertCurrent();
    };
    assertCurrent();
    const preparation = readWorkerProjectPreparation(profileSnapshot.project);
    const intent = {
      providerId,
      profileSnapshot,
      ...(preparation ? { preparationKey: preparation.key } : {}),
    };
    const admittedSnapshot = structuredClone(intent);
    preparedIntents.set(intent, {
      profileId,
      assertCurrent: () => {
        assertCurrent();
        if (!isDeepStrictEqual(intent, admittedSnapshot)) {
          throw serviceError(
            "invalid_state",
            "Prepared worker intent was changed after preparation",
          );
        }
      },
    });
    return intent;
  };

  // Retention checks immutable contents against local policy/runtime facts. This
  // closure deliberately cannot authorize an allocation or claim private source.
  const prepareRetention = async (record: WorkerEnvironmentRecord, signal?: AbortSignal) => {
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
    if (!project || !preparation || !options.prepareNodeArtifacts || !options.projectNamespace) {
      return undefined;
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
      !provider.requiresNodeEnrollment ||
      !provider.supportsProjectPreparation?.(profile, createOptions.machineClass, createOptions.os)
    ) {
      return undefined;
    }
    const assertProfileCurrent = () => {
      const current = resolveProfile(record.profileId, createOptions);
      if (
        current.provider !== provider ||
        !isDeepStrictEqual(current.profileSnapshot, profileSnapshot) ||
        !isDeepStrictEqual(
          provider.resolvePreparationTarget?.(
            profile,
            createOptions.machineClass,
            createOptions.os,
          ),
          target,
        ) ||
        !provider.requiresNodeEnrollment ||
        !provider.supportsProjectPreparation?.(
          profile,
          createOptions.machineClass,
          createOptions.os,
        )
      ) {
        throw serviceError("invalid_profile", "Prepared worker retention policy changed");
      }
      if ("source" in project) {
        const config = options.getConfig();
        const { agent, identity } = project.source.owner;
        const agentIdentity = resolveConfiguredGitHubToolIdentity({
          config,
          agentId: agent.agentId,
          scope: "agent",
        });
        const systemIdentity = resolveConfiguredGitHubToolIdentity({
          config,
          agentId: agent.agentId,
          scope: "system",
        });
        const selected = agentIdentity ?? systemIdentity;
        const selectedSource = agentIdentity ? "agent-override" : "system-configured";
        if (
          !matchesAgentLifecycleBinding(config, agent) ||
          (selected
            ? identity.source !== selectedSource ||
              !("profileId" in identity) ||
              identity.profileId !== selected.profileId
            : identity.source !== "anonymous" && identity.source !== "system-detected")
        ) {
          throw serviceError("invalid_profile", "Prepared repository owner selection changed");
        }
      }
    };
    assertProfileCurrent();
    const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
    const assertCurrent = () => {
      assertProfileCurrent();
      prepared.assertCurrent();
    };
    assertCurrent();
    const observed = createWorkerProjectPreparationIdentity({
      namespace: options.projectNamespace,
      providerId,
      profileId: record.profileId,
      profileSnapshot,
      project,
      target,
      artifacts: prepared.artifacts,
      setupRecipe: preparation.setupRecipe,
      runSetupScript: preparation.runSetupScript,
    });
    return isDeepStrictEqual(observed, preparation) ? { assertCurrent } : undefined;
  };

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
    admittedIntent?: WorkerProviderPreparedIntent,
  ) => {
    const {
      inherited: requestedInherited,
      machineClass,
      os,
      executionMode,
      projectPath,
      signal,
    } = createOptions;
    signal?.throwIfAborted();
    const inherited = requestedInherited
      ? { ...requestedInherited, profileSnapshot: { ...requestedInherited.profileSnapshot } }
      : undefined;
    // Project authority belongs to this allocation. Ignore the source allocation's
    // descriptor during both fresh admission and comparison with an existing intent.
    if (inherited) {
      delete inherited.profileSnapshot.project;
    }
    const provisionSnapshot = {
      ...(machineClass === undefined ? {} : { machineClass }),
      ...(os === undefined ? {} : { os }),
      ...(executionMode === undefined ? {} : { executionMode }),
    };
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        const existingProject = readWorkerProjectSnapshot(existing.profileSnapshot.project);
        if (existingProject && projectPath) {
          const root = await fsp.realpath(projectPath);
          signal?.throwIfAborted();
          if ("source" in existingProject || existingProject.root !== root) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
        }
        if (admittedIntent) {
          assertPreparedIntentCurrent(profileId, admittedIntent);
          if (
            !isDeepStrictEqual(
              projectReplayIdentity(existing.profileSnapshot.project),
              projectReplayIdentity(admittedIntent.profileSnapshot.project),
            )
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        } else if (createOptions.repository || createOptions.projectRepository) {
          const requested = await prepareIntent(profileId, createOptions);
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, requested);
          if (
            !isDeepStrictEqual(
              projectReplayIdentity(existing.profileSnapshot.project),
              projectReplayIdentity(requested.profileSnapshot.project),
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
                ...provisionSnapshot,
                ...(existingProject ? { project: existing.profileSnapshot.project } : {}),
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
        if (!existing.leaseId && inState(existing, "requested", "provisioning")) {
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
      const current = resolveProfile(profileId, createOptions);
      const { project: _project, ...admittedProfile } = admitted.profileSnapshot;
      if (
        admitted.providerId !== current.providerId ||
        !isDeepStrictEqual(admittedProfile, current.profileSnapshot) ||
        admitted.preparationKey !==
          readWorkerProjectPreparation(admitted.profileSnapshot.project)?.key
      ) {
        throw serviceError(
          "invalid_profile",
          "Prepared worker intent no longer matches its profile",
        );
      }
      const { provider } = current;
      const { providerId, profileSnapshot } = admitted;
      const intent = store.createIntent({
        environmentId,
        providerId,
        profileId: normalizedProfileId,
        profileSnapshot,
        provisionOperationId,
      });
      return resumeProvision(intent, provider, signal);
    });
  };
  return { prepareIntent, prepareRetention, assertPreparedIntentCurrent, createWithProfile };
}
