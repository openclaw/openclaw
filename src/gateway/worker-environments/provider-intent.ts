import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as agents from "../../agents/agent-lifecycle-registry.js";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { resolveGitRepositoryPaths } from "../../agents/worktrees/git.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { assertEnvironmentRecipeSecretsMapped } from "./environment-recipe.js";
import {
  createWorkerPreparationIdentity,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import * as prep from "./preparation-identity.schema.js";
import * as projects from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerProviderRepositorySource } from "./provider-project-preparation.js";
import {
  prepareWorkerRetentionPolicy,
  requireAdmittedWorkerRetentionPolicy,
} from "./provider-retention-policy.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as validation from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
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
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
    wakeRetained?: () => void,
  ) => Promise<WorkerEnvironmentRecord>;
};

export type WorkerProviderIntentPreparationOptions = {
  retainedPolicy?: import("../../plugins/worker-retention.types.js").WorkerRetentionPolicy;
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  projectCommit?: string;
  /** Refill only: the retained source already admitted an empty committed workspace. */
  emptyWorkspace?: true;
  /** Dedicated runtime capacity without repository contents or read authority. */
  imageReserve?: true;
  repository?: {
    agentId: string;
    url: string;
    ref?: string;
    baseCommit?: string;
    workspaceId?: string;
  };
  projectRepository?: RepositoryWorkerProjectSnapshot;
  runSetupScript?: boolean;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
  beforeProvision?: () => void;
  assertCurrent?: () => void;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
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

export async function failUnallocatedImageIntent(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "move">,
  record: WorkerEnvironmentRecord,
  error: unknown,
  signal: AbortSignal,
): Promise<never> {
  const preparation = prep.readWorkerPreparation(record.profileSnapshot);
  const current = options.store.get(record.environmentId);
  // Reconciliation must not retry a refused image without its live admission.
  // Provisioning rows can already own a paid lease; cancellation owns its teardown.
  if (
    !signal.aborted &&
    preparation &&
    "source" in preparation &&
    preparation.source === "image" &&
    current?.state === "requested" &&
    current.provisionOperationId === record.provisionOperationId &&
    current.ownerEpoch === record.ownerEpoch &&
    current.destroyRequestedAtMs === null
  ) {
    await options.move(current, "failed", { lastError: boundedWorkerError(error) });
  }
  throw error;
}

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const preparedIntents = new WeakMap<
    WorkerProviderPreparedIntent,
    { profileId: string; assertCurrent: () => void; repository?: WorkerProviderRepositorySource }
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
      validation.requireInheritedWorkerProfileAuthorization(
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
      profileSnapshot = validation.snapshotWorkerAllocationProfile(configuredProfile);
    }
    const snapshot = allocationSnapshot(profileSnapshot, createOptions);
    validation.requireWorkerProfile(snapshot);
    return {
      provider,
      providerId,
      profileSnapshot: structuredClone(snapshot),
    };
  };

  const isImageProfileCurrent = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
    admitted: ReturnType<typeof resolveProfile>,
    target: prep.WorkerProjectPreparationIdentity["target"],
  ) => {
    const current = resolveProfile(profileId, { ...createOptions, inherited: undefined });
    const profile = validation.requireWorkerProfile(current.profileSnapshot.settings);
    const { provider } = admitted;
    const machineClass =
      typeof admitted.profileSnapshot.machineClass === "string"
        ? admitted.profileSnapshot.machineClass
        : undefined;
    const os =
      typeof admitted.profileSnapshot.os === "string" ? admitted.profileSnapshot.os : undefined;
    return (
      current.provider === provider &&
      current.providerId === admitted.providerId &&
      isDeepStrictEqual(current.profileSnapshot, admitted.profileSnapshot) &&
      provider.requiresNodeEnrollment === true &&
      provider.supportsProjectPreparation?.(profile, machineClass, os) === true &&
      isDeepStrictEqual(provider.resolvePreparationTarget?.(profile, machineClass, os), target)
    );
  };

  const prepareIntent = async (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
  ): Promise<WorkerProviderPreparedIntent> => {
    const resolved = resolveProfile(profileId, createOptions);
    const { provider, providerId } = resolved;
    const { signal, projectPath } = createOptions;
    let profileSnapshot: WorkerProviderPreparedIntent["profileSnapshot"] = resolved.profileSnapshot;
    const retainedPolicy = prepareWorkerRetentionPolicy({
      projectNamespace: options.projectNamespace,
      workspaceId: createOptions.repository?.workspaceId,
      imageReserve: createOptions.imageReserve,
      profileSnapshot,
      provider,
      retainedPolicy: createOptions.retainedPolicy,
    });
    const machineClass =
      typeof profileSnapshot.machineClass === "string" ? profileSnapshot.machineClass : undefined;
    const os = typeof profileSnapshot.os === "string" ? profileSnapshot.os : undefined;
    let repositoryAdmission:
      | Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>
      | undefined;
    const profile = validation.requireWorkerProfile(profileSnapshot.settings);
    let assertImageCurrent: (() => void) | undefined;
    if (
      [
        projectPath,
        createOptions.repository,
        createOptions.projectRepository,
        createOptions.emptyWorkspace,
        createOptions.imageReserve,
      ].filter(Boolean).length > 1
    ) {
      throw serviceError(
        "invalid_profile",
        "Worker preparation must have exactly one project source",
      );
    }
    // A session-private retained disk cannot consume a fixed-lease prepared image/reserve.
    const supportsProjectPreparation =
      !retainedPolicy && provider.supportsProjectPreparation?.(profile, machineClass, os);
    if (
      (projectPath ||
        createOptions.repository ||
        createOptions.projectRepository ||
        ((createOptions.emptyWorkspace || createOptions.imageReserve) &&
          supportsProjectPreparation)) &&
      (supportsProjectPreparation || provider.runSetupCommand)
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
            createOptions.assertCurrent?.();
          },
          readNativeCredential: createOptions.readNativeCredential,
          retainCredentialCleanup: createOptions.retainCredentialCleanup,
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
              const cached = projects.readWorkerProjectSnapshot(value);
              const preparation = prep.readWorkerProjectPreparation(value);
              if (
                cached &&
                "source" in cached &&
                preparation &&
                preparation.recipe &&
                isDeepStrictEqual(cached, admittedProject)
              ) {
                return {
                  setupRecipe: preparation.setupRecipe,
                  recipe: preparation.recipe,
                };
              }
            }
            return undefined;
          },
        });
      }
      const project =
        createOptions.emptyWorkspace || createOptions.imageReserve
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
        const recipe = project
          ? "source" in project
            ? repositoryAdmission?.recipe
            : await projects.readWorkerProjectEnvironmentRecipe(project, signal)
          : undefined;
        assertEnvironmentRecipeSecretsMapped(recipe, profile.setupSecrets);
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
          if (createOptions.imageReserve) {
            const admittedTarget = structuredClone(target);
            assertImageCurrent = () => {
              createOptions.assertCurrent?.();
              if (!isImageProfileCurrent(profileId, createOptions, resolved, admittedTarget)) {
                throw serviceError("invalid_profile", "Runtime-only worker preparation changed");
              }
            };
            assertImageCurrent();
          }
          const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
          signal?.throwIfAborted();
          assertImageCurrent?.();
          const preparation = createWorkerPreparationIdentity({
            namespace: options.projectNamespace,
            providerId,
            profileId,
            profileSnapshot,
            project: project ?? undefined,
            imageReserve: createOptions.imageReserve,
            target,
            artifacts: prepared.artifacts,
            setupRecipe,
            recipe,
            runSetupScript: createOptions.runSetupScript,
          });
          profileSnapshot = project
            ? { ...resolved.profileSnapshot, project: { ...project, preparation } }
            : {
                ...resolved.profileSnapshot,
                runtimePreparation: {
                  source: createOptions.imageReserve ? "image" : "empty",
                  ...preparation,
                },
              };
        } else if (project && supportsProjectPreparation) {
          profileSnapshot = { ...resolved.profileSnapshot, project };
        }
      }
    }
    if (createOptions.imageReserve && !prep.readWorkerPreparation(profileSnapshot)) {
      throw serviceError(
        "invalid_profile",
        "Worker profile cannot prepare runtime-only image capacity",
      );
    }
    const intent = {
      providerId,
      profileSnapshot,
      ...(retainedPolicy ? { retainedPolicy } : {}),
    };
    preparedIntents.set(intent, {
      profileId,
      // Reusable local artifacts outlive their producer. Repository authority and
      // runtime-only image policy remain live until the allocation or claim.
      assertCurrent: () => {
        repositoryAdmission?.assertCurrent();
        assertImageCurrent?.();
      },
      repository: repositoryAdmission,
    });
    return intent;
  };

  // Retention checks immutable contents against local policy/runtime facts.
  // Unknown observations throw; only confirmed incompatibility returns undefined/false.
  // This closure cannot authorize an allocation or claim private source.
  const prepareRetention = async (
    record: WorkerEnvironmentRecord,
    preparation: prep.WorkerProjectPreparationIdentity | prep.WorkerRuntimePreparationIdentity,
    signal?: AbortSignal,
    onInvalid?: (reason: string) => void,
  ) => {
    const invalid = (reason: string) => {
      onInvalid?.(reason);
      return undefined;
    };
    const project = projects.readWorkerProjectSnapshot(record.profileSnapshot.project);
    if (!options.prepareNodeArtifacts || !options.projectNamespace) {
      return invalid("preparation runtime is unavailable");
    }
    const source = prep.workerPreparationSourceKey(record.profileSnapshot);
    const projectPreparation = "source" in preparation ? undefined : preparation;
    const createOptions: WorkerProviderIntentPreparationOptions = {
      ...(source === "image" ? { imageReserve: true } : {}),
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
    const configured = options.getConfig().cloudWorkers?.profiles?.[record.profileId];
    if (
      !configured ||
      normalizeCapabilityProviderId(configured.provider) !== record.providerId ||
      !isDeepStrictEqual(
        allocationSnapshot(validation.snapshotWorkerAllocationProfile(configured), createOptions),
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
      !(await agents.matchesAgentLifecycleBindingAsync(
        options.getConfig,
        project.source.owner.agent,
      ))
    ) {
      return invalid("repository agent changed");
    }
    const resolved = resolveProfile(record.profileId, createOptions);
    const { provider, providerId, profileSnapshot } = resolved;
    const profile = validation.requireWorkerProfile(profileSnapshot.settings);
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
    const isCurrent = () => {
      if (
        source === "image" &&
        !isImageProfileCurrent(record.profileId, createOptions, resolved, preparation.target)
      ) {
        return false;
      }
      return (
        isSourceOwnerCurrent() &&
        (!project ||
          !("source" in project) ||
          agents.matchesAgentLifecycleBinding(options.getConfig(), project.source.owner.agent))
      );
    };
    if (!isCurrent()) {
      return invalid("repository owner changed during retention");
    }
    const observed = createWorkerPreparationIdentity({
      namespace: options.projectNamespace,
      providerId,
      profileId: record.profileId,
      profileSnapshot,
      project,
      imageReserve: createOptions.imageReserve,
      target,
      artifacts: prepared.artifacts,
      setupRecipe: projectPreparation?.setupRecipe,
      recipe: projectPreparation?.recipe,
      runSetupScript: projectPreparation?.runSetupScript,
    });
    return isDeepStrictEqual(project ? observed : { source, ...observed }, preparation)
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
    const retainedPolicy = requireAdmittedWorkerRetentionPolicy(
      createOptions.retainedPolicy,
      admittedIntent?.retainedPolicy,
    );
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
    const beforeProvision = (intent?: WorkerProviderPreparedIntent) => () => {
      createOptions.beforeProvision?.();
      if (intent?.profileSnapshot.runtimePreparation?.source === "image") {
        assertPreparedIntentCurrent(profileId, intent);
      }
    };
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      await store.ready();
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        if (!isDeepStrictEqual(existing.retention?.policy, retainedPolicy)) {
          throw serviceError(
            "invalid_profile",
            "Idempotency key belongs to another retention policy",
          );
        }
        const existingProject = projects.readWorkerProjectSnapshot(
          existing.profileSnapshot.project,
        );
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
        // Replay settles this stored allocation, rather than selecting a new image profile.
        const imageReplay = prep.workerPreparationSourceKey(existing.profileSnapshot) === "image";
        if (imageReplay && (projectPath || createOptions.emptyWorkspace)) {
          throw serviceError(
            "invalid_profile",
            "Idempotency key belongs to another project preparation",
          );
        }
        const requested =
          admittedIntent ??
          (createOptions.repository ||
          createOptions.projectRepository ||
          (createOptions.imageReserve && !imageReplay)
            ? await prepareIntent(profileId, createOptions)
            : undefined);
        if (requested) {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, requested);
          if (
            !isDeepStrictEqual(
              projects.projectReplayIdentity(existing.profileSnapshot.project),
              projects.projectReplayIdentity(requested.profileSnapshot.project),
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
          return resumeProvision(
            existing,
            undefined,
            signal,
            undefined,
            beforeProvision(requested),
            requested ? preparedIntents.get(requested)?.repository : undefined,
            existing.retention ? beforeProvision(requested) : undefined,
          );
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
      const { providerId, profileSnapshot } = admitted;
      const provider = providerFor(providerId);
      const intent = await store.createIntent(
        {
          environmentId,
          providerId,
          profileId: normalizedProfileId,
          profileSnapshot,
          provisionOperationId,
          retention: retainedPolicy ?? admitted.retainedPolicy,
        },
        () => {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, admitted);
        },
      );
      return resumeProvision(
        intent,
        provider,
        signal,
        undefined,
        beforeProvision(admitted),
        preparedIntents.get(admitted)?.repository,
      );
    });
  };
  return { prepareIntent, prepareRetention, assertPreparedIntentCurrent, createWithProfile };
}
