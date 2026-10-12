import path from "node:path";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
  type ProjectRecord,
  validateProjectsAddParams,
  type ProjectSummary,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateProjectsSearchRemoteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../../agents/github-host.js";
import { readCachedNativeGitHubToken } from "../../agents/github-read-identity.js";
import { readRegistryWorktrees } from "../../agents/worktrees/registry-read.js";
import {
  captureWorktreeRegistryAuthority,
  captureWorktreeRunEndContext,
} from "../../agents/worktrees/run-end-lifecycle.js";
import { managedWorktrees, type ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../../config/sessions/combined-store-gateway-read.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionStoreEntries,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { ProjectCloneError } from "../../projects/project-clone-runtime.js";
import {
  materializeProjectClone,
  removeClonedProjectCheckout,
} from "../../projects/project-clone.js";
import {
  listProjectRegistry,
  listWorkspaceProjects,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { isTrustedSecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { prepareCurrentUserProfileAliases } from "../../state/user-profile-reads.js";
import { configuredDefaultRepository } from "../configured-default-repository.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  gitHubPublicApi,
  githubApiToken,
} from "../github-public-api.js";
import {
  WRITE_SCOPE,
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
} from "../method-scopes.js";
import { searchRemoteProjects } from "../project-github-search.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { startProjectsListDiagnostics } from "./projects-list-diagnostics.js";
import { listProjectRecents } from "./projects-recents.js";
import {
  assertMemoryProjectStoresCurrent,
  loadProjectSessionStore,
  readMemoryProjectStores,
  type IncognitoStores,
} from "./projects-session-store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

type ProjectWorktreeService = Pick<
  ManagedWorktreeService,
  "listRegistryRecords" | "resolveRepositoryIdentities"
>;

type ProjectCandidate = {
  checkoutPath: string;
  fingerprint: string;
  lastUsedAt: number;
  originUrl?: string;
};

type RawProjectCandidate =
  | { kind: "session"; checkoutPath: string; lastUsedAt: number }
  | {
      kind: "worktree";
      checkoutPath: string;
      fingerprint: string;
      lastUsedAt: number;
      repoRoot: string;
    };

type ProjectGroup = {
  checkouts: Map<string, { path: string; lastUsedAt: number }>;
  lastUsedAt: number;
  name: string;
  nameUsedAt: number;
  originUrl?: string;
};

// This buffer must cover the largest possible response/checkouts while remaining independent of
// session history. Identity resolution has its own lower subprocess ceiling within this bound.
const PROJECTS_LIST_MAX_RAW_CANDIDATES = Math.max(
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
);

function checkoutName(checkoutPath: string): string {
  const trimmed = checkoutPath.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}

function compareRawProjectCandidates(left: RawProjectCandidate, right: RawProjectCandidate) {
  return (
    right.lastUsedAt - left.lastUsedAt ||
    left.checkoutPath.localeCompare(right.checkoutPath) ||
    left.kind.localeCompare(right.kind)
  );
}

function retainNewestRawProjectCandidate(
  candidates: RawProjectCandidate[],
  candidate: RawProjectCandidate,
) {
  const insertionIndex = candidates.findIndex(
    (existing) => compareRawProjectCandidates(candidate, existing) < 0,
  );
  if (insertionIndex < 0 && candidates.length >= PROJECTS_LIST_MAX_RAW_CANDIDATES) {
    return;
  }
  candidates.splice(insertionIndex < 0 ? candidates.length : insertionIndex, 0, candidate);
  if (candidates.length > PROJECTS_LIST_MAX_RAW_CANDIDATES) {
    candidates.pop();
  }
}

function sanitizePublicOriginUrl(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const suffixIndex = trimmed.search(/[?#]/u);
  const withoutSuffix = suffixIndex < 0 ? trimmed : trimmed.slice(0, suffixIndex);
  const scp = /^[^@\s/:]+@(\[[^\]]+\]|[^:\s]+):(.+)$/u.exec(withoutSuffix);
  if (scp) {
    return `${scp[1]}:${scp[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutSuffix);
  } catch {
    return undefined;
  }
  if (!parsed.username && !parsed.password) {
    return withoutSuffix;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function sanitizeProjectRecord(project: ProjectRecord): ProjectRecord {
  const { originUrl, ...record } = project;
  const sanitizedOriginUrl = originUrl ? sanitizePublicOriginUrl(originUrl) : undefined;
  return {
    ...record,
    ...(sanitizedOriginUrl ? { originUrl: sanitizedOriginUrl } : {}),
  };
}

function projectCheckoutError(error: unknown) {
  return errorShape(
    error instanceof ProjectCheckoutError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

function projectCandidatesToSummaries(candidates: readonly ProjectCandidate[]): ProjectSummary[] {
  const groups = new Map<string, ProjectGroup>();
  for (const candidate of candidates) {
    const group: ProjectGroup = groups.get(candidate.fingerprint) ?? {
      checkouts: new Map(),
      lastUsedAt: candidate.lastUsedAt,
      name: checkoutName(candidate.checkoutPath),
      nameUsedAt: candidate.lastUsedAt,
    };
    const checkout = group.checkouts.get(candidate.checkoutPath);
    if (!checkout || candidate.lastUsedAt > checkout.lastUsedAt) {
      group.checkouts.set(candidate.checkoutPath, {
        path: candidate.checkoutPath,
        lastUsedAt: candidate.lastUsedAt,
      });
    }
    group.lastUsedAt = Math.max(group.lastUsedAt, candidate.lastUsedAt);
    if (candidate.lastUsedAt > group.nameUsedAt) {
      group.name = checkoutName(candidate.checkoutPath);
      group.nameUsedAt = candidate.lastUsedAt;
    }
    if (!group.originUrl && candidate.originUrl) {
      group.originUrl = candidate.originUrl;
    }
    groups.set(candidate.fingerprint, group);
  }
  return [...groups.values()]
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    )
    .slice(0, PROJECTS_LIST_DEFAULT_LIMIT)
    .map((group) => {
      const summary: ProjectSummary = {
        name: group.name,
        checkouts: [...group.checkouts.values()]
          .toSorted(
            (left, right) =>
              right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path),
          )
          .slice(0, PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT)
          .map((checkout) => ({ runnerId: "gateway", path: checkout.path })),
        lastUsedAt: group.lastUsedAt,
      };
      if (group.originUrl) {
        const originUrl = sanitizePublicOriginUrl(group.originUrl);
        if (originUrl) {
          summary.originUrl = originUrl;
        }
      }
      return summary;
    });
}

async function listObservedProjects(
  service: ProjectWorktreeService,
  context: Parameters<GatewayRequestHandlers["projects.list"]>[0]["context"],
  client: Parameters<GatewayRequestHandlers["projects.list"]>[0]["client"],
  store: Awaited<ReturnType<typeof loadCombinedSessionStoreForGatewayCoreAsync>>["store"],
  diagnostics?: ReturnType<typeof startProjectsListDiagnostics>,
): Promise<ProjectSummary[]> {
  diagnostics?.mark("worktreeRegistry");
  const worktrees = await service.listRegistryRecords();
  diagnostics?.mark("sessionCandidates");
  const cfg = context.getRuntimeConfig();
  const rawCandidates: RawProjectCandidate[] = [];
  const visibilityFilter = createSessionListEntryFilter({ client, cfg });
  const canSeeAll = !visibilityFilter;
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (visibilityFilter && !visibilityFilter(sessionKey, entry)) {
      continue;
    }
    const checkoutPath = entry.execCwd?.trim();
    if (checkoutPath && !entry.execNode?.trim()) {
      retainNewestRawProjectCandidate(rawCandidates, {
        kind: "session",
        checkoutPath,
        lastUsedAt: entry.updatedAt,
      });
    }
  }
  diagnostics?.mark("worktreeCandidates");
  for (const worktree of worktrees) {
    if (worktree.removedAt !== undefined) {
      continue;
    }
    if (!canSeeAll) {
      // Session-owned worktrees use their canonical session key as ownerId, so the same
      // visibility policy that admitted the session also owns its managed checkout.
      const ownerId = worktree.ownerKind === "session" ? worktree.ownerId?.trim() : undefined;
      const ownerEntry = ownerId ? store[ownerId] : undefined;
      if (!ownerId || !ownerEntry || !visibilityFilter?.(ownerId, ownerEntry)) {
        continue;
      }
    }
    retainNewestRawProjectCandidate(rawCandidates, {
      kind: "worktree",
      checkoutPath: worktree.path,
      fingerprint: worktree.repoFingerprint,
      lastUsedAt: worktree.lastActiveAt,
      repoRoot: worktree.repoRoot,
    });
  }

  // Admit newest-first paths before canonicalizing the shared discovery pass's key.
  diagnostics?.mark("identityProbes");
  const probePaths = [
    ...new Set(
      rawCandidates.map((raw) => (raw.kind === "worktree" ? raw.repoRoot : raw.checkoutPath)),
    ),
  ]
    .slice(0, PROJECTS_LIST_MAX_IDENTITY_PROBES)
    .toSorted();
  const results = probePaths.length ? await service.resolveRepositoryIdentities(probePaths) : [];
  const identities = new Map(
    probePaths.map((checkoutPath, index) => [checkoutPath, results[index]]),
  );

  diagnostics?.mark("candidateProcessing");
  const candidates: ProjectCandidate[] = [];
  for (const raw of rawCandidates) {
    const identity = identities.get(raw.kind === "worktree" ? raw.repoRoot : raw.checkoutPath);
    const checkout =
      raw.kind === "worktree"
        ? { checkoutPath: raw.checkoutPath, fingerprint: raw.fingerprint }
        : identity && { checkoutPath: identity.checkoutRoot, fingerprint: identity.fingerprint };
    if (!checkout) {
      continue;
    }
    // Registry facts survive a missing source checkout or exhausted probe budget.
    candidates.push({
      ...checkout,
      lastUsedAt: raw.lastUsedAt,
      ...(identity?.originUrl ? { originUrl: identity.originUrl } : {}),
    });
  }

  // M5: merge operator-enabled device checkout advertisements at this seam.
  return projectCandidatesToSummaries(candidates);
}

function findSessionCheckoutReference(
  repoRoot: string,
  entries: Iterable<readonly [string, SessionEntry]>,
): string | undefined {
  const normalizedRoot = path.resolve(repoRoot);
  for (const [key, entry] of entries) {
    if (entry.archivedAt) {
      continue;
    }
    const sessionRoot = entry.worktree?.repoRoot;
    const cwd = entry.spawnedCwd;
    if (
      (sessionRoot && path.resolve(sessionRoot) === normalizedRoot) ||
      (cwd &&
        (path.resolve(cwd) === normalizedRoot || isPathInside(normalizedRoot, path.resolve(cwd))))
    ) {
      return key;
    }
  }
  return undefined;
}

async function findProjectCheckoutReference(
  cfg: Parameters<typeof listProjectRegistry>[0],
  repoRoot: string,
  worktrees: readonly ManagedWorktreeRecord[],
  incognitoStores?: IncognitoStores,
): Promise<string | undefined> {
  const normalizedRoot = path.resolve(repoRoot);
  const workspaceReference = listWorkspaceProjects(cfg).find(
    (candidate) => path.resolve(candidate.repoRoot) === normalizedRoot,
  );
  const worktreeReference = worktrees.find(
    (worktree) => !worktree.removedAt && path.resolve(worktree.repoRoot) === normalizedRoot,
  );
  const sessionReference = findSessionCheckoutReference(normalizedRoot, [
    ...Object.entries(
      (
        await loadCombinedSessionStoreForGatewayCoreAsync(cfg, {
          projection: "list",
          ...(incognitoStores && { includeIncognito: false }),
        })
      ).store,
    ),
    ...(incognitoStores?.flatMap((store) =>
      store.entries.map(({ sessionKey, entry }) => [sessionKey, entry] as const),
    ) ?? []),
  ]);
  return workspaceReference
    ? `agent workspace ${workspaceReference.displayName}`
    : worktreeReference
      ? `managed worktree ${worktreeReference.name}`
      : sessionReference
        ? `session ${sessionReference}`
        : undefined;
}

export function createProjectsHandlers(service: ProjectWorktreeService): GatewayRequestHandlers {
  return {
    "projects.list": async ({ params, respond, context, client }) => {
      if (!assertValidParams(params, validateProjectsListParams, "projects.list", respond)) {
        return;
      }
      const diagnostics = startProjectsListDiagnostics(context);
      const cfg = context.getRuntimeConfig();
      const defaultRepository = configuredDefaultRepository(cfg);
      const requesterProfileId = client?.authenticatedUserProfile?.profileId;
      const requesterUserId = client?.authenticatedUserId;
      const accessRevision = readGatewayAccessRevision();
      const assertCurrent = () => {
        if (
          client?.authenticatedUserProfile?.profileId !== requesterProfileId ||
          client?.authenticatedUserId !== requesterUserId ||
          readGatewayAccessRevision() !== accessRevision ||
          context.getRuntimeConfig() !== cfg
        ) {
          throw new Error("Project access changed while preparing the listing. Retry the request.");
        }
      };
      const list = async (
        incognitoStores?: IncognitoStores,
        assertIncognitoCurrent?: () => void,
      ) => {
        const registryProjects = await listProjectRegistry(cfg);
        assertCurrent();
        diagnostics?.mark("sessions");
        const projects = registryProjects.map(sanitizeProjectRecord);
        const canWrite = () =>
          authorizeOperatorScopesForRequiredScope(
            WRITE_SCOPE,
            Array.isArray(client?.connect.scopes) ? client.connect.scopes : [],
          ).allowed;
        const canCreateSession = () =>
          authorizeOperatorScopesForMethod(
            "sessions.create",
            Array.isArray(client?.connect.scopes) ? client.connect.scopes : [],
          ).allowed;
        let store: Awaited<
          ReturnType<typeof loadCombinedSessionStoreForGatewayCoreAsync>
        >["store"] = {};
        let observedProjects: ProjectSummary[] | undefined;
        if (client?.authenticatedUserProfile?.profileId || (params.includeObserved && canWrite())) {
          const projection = requireSessionRowProjection(context);
          do {
            await projection.prepareSelection();
          } while (projection.needsSelectionPreparation());
          assertCurrent();
          if (getSessionRowProjection(context) !== projection || projection.state.cfg !== cfg) {
            throw new Error(
              "Session projection changed while preparing the listing. Retry the request.",
            );
          }
          store = loadProjectSessionStore(projection, incognitoStores);
          assertCurrent();
        }
        if (params.includeObserved && canWrite()) {
          observedProjects = await listObservedProjects(
            service,
            context,
            client,
            store,
            diagnostics,
          );
          assertCurrent();
        }
        diagnostics?.mark("recents");
        const profileId = client?.authenticatedUserProfile?.profileId;
        const recentProfile = profileId
          ? await prepareCurrentUserProfileAliases(profileId)
          : undefined;
        assertCurrent();
        const recents = recentProfile
          ? await listProjectRecents(store, recentProfile.aliases, registryProjects)
          : undefined;
        recentProfile?.assertCurrent();
        diagnostics?.mark("response");
        assertCurrent();
        const writable = canWrite();
        const canCreate = canCreateSession();
        assertIncognitoCurrent?.();
        // Project identity is read-safe; host paths, origins, folders, and observed checkouts are
        // placement details reserved for clients that can create sessions.
        respond(
          true,
          {
            projects: writable
              ? projects
              : projects.map(({ id, displayName, source, agentId }) =>
                  agentId ? { id, displayName, source, agentId } : { id, displayName, source },
                ),
            ...(canCreate ? { githubHost: resolveConfiguredGitHubHost(cfg) } : {}),
            ...(defaultRepository && (writable || canCreate) ? { defaultRepository } : {}),
            ...(recents
              ? {
                  recents: writable
                    ? recents
                    : recents.filter((recent) => recent.kind === "project"),
                }
              : {}),
            ...(writable && observedProjects ? { observedProjects } : {}),
          },
          undefined,
        );
      };
      try {
        const memory = getSessionActorStorageBinding({});
        if (memory) {
          const stores = readMemoryProjectStores(memory);
          await list(stores, () => assertMemoryProjectStoresCurrent(memory, stores));
        } else if (captureIncognitoSessionBinding()) {
          await withIncognitoSessionStoreEntries(list);
        } else {
          await list();
        }
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      } finally {
        diagnostics?.finish();
      }
    },
    "projects.register": defineValidatedGatewayHandler(
      "projects.register",
      validateProjectsRegisterParams,
      async ({ params, respond }) => {
        respond(
          true,
          sanitizeProjectRecord(
            await registerProjectRegistry({ path: params.path, name: params.name }),
          ),
          undefined,
        );
      },
      projectCheckoutError,
    ),
    "projects.add": defineValidatedGatewayHandler(
      "projects.add",
      validateProjectsAddParams,
      async ({ params, respond, context, signal }) => {
        const cfg = context.getRuntimeConfig();
        respond(
          true,
          await materializeProjectClone(
            { cfg, gitUrl: params.gitUrl, name: params.name },
            { signal, token: githubApiToken(process.env, cfg) },
          ),
          undefined,
        );
      },
      (error) => {
        const failure = isTrustedSecretSurfaceUnavailableError(error)
          ? { cause: "auth_required", message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE }
          : error instanceof ProjectCloneError
            ? { cause: error.failure, message: error.message }
            : undefined;
        return failure
          ? errorShape(
              failure.cause === "invalid_url" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
              failure.message,
              {
                details: {
                  code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
                  cause: failure.cause,
                },
                retryable: failure.cause === "network" || failure.cause === "clone_failed",
              },
            )
          : errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
      },
    ),
    "projects.searchRemote": defineValidatedGatewayHandler(
      "projects.searchRemote",
      validateProjectsSearchRemoteParams,
      async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
        const cfg = context.getRuntimeConfig();
        const host = resolveConfiguredGitHubHost(cfg);
        const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(cfg);
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (hasCurrentClientAuthority?.() === false) {
            throw new Error("Project requester authority changed during search");
          }
          if (context.getRuntimeConfig() !== cfg) {
            throw new gitHubPublicApi.ControlUiGitHubError(
              502,
              "GitHub host changed during project search",
            );
          }
        };
        assertCurrent();
        const nativeToken =
          cfg.gateway?.projects?.nativeGitHubSearch === true
            ? await readCachedNativeGitHubToken(process.env)
            : undefined;
        assertCurrent();
        const result = await searchRemoteProjects(params.query, {
          assertCurrent,
          trackExecution: (run) => context.trackExecution(run),
          signal,
          host,
          apiBaseUrl,
          ...(cfg.gateway?.projects?.nativeGitHubSearch === true
            ? { token: nativeToken ?? "" }
            : {}),
        });
        assertCurrent();
        respond(true, result, undefined);
      },
      (error) => {
        const { message, ...details } =
          error instanceof gitHubPublicApi.ControlUiGitHubError ||
          isTrustedSecretSurfaceUnavailableError(error)
            ? gitHubPublicApi.formatControlUiGitHubPreviewError(error)
            : { message: "GitHub project search is unavailable. Retry shortly.", retryable: true };
        return errorShape(ErrorCodes.UNAVAILABLE, message, details);
      },
    ),
    "projects.remove": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateProjectsRemoveParams, "projects.remove", respond)) {
        return;
      }
      const worktreeContext = captureWorktreeRunEndContext(process.env);
      const respondUnknownProject = () => {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${params.id}`),
        );
      };
      const project = await resolveProjectRegistry(context.getRuntimeConfig(), params.id);
      if (!project || project.source === "workspace") {
        respondUnknownProject();
        return;
      }
      let removed: boolean;
      if (params.deleteCheckout) {
        if (project.source !== "cloned") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "Only projects cloned by the Gateway can delete their checkout.",
            ),
          );
          return;
        }
        try {
          const memory = getSessionActorStorageBinding({});
          const assertWorktreesCurrent = captureWorktreeRegistryAuthority(worktreeContext, [
            { id: "*", fields: ["identity", "removal"] },
          ]);
          const worktrees = await readRegistryWorktrees(process.env, {}, worktreeContext);
          worktreeContext.admission.assertCurrent();
          assertWorktreesCurrent();
          const remove = (
            incognitoStores?: IncognitoStores,
            assertIncognitoCurrent?: () => void,
          ) => {
            const assertCurrent = () => {
              worktreeContext.admission.assertCurrent();
              assertWorktreesCurrent();
              assertIncognitoCurrent?.();
              if (memory) {
                const reference = findSessionCheckoutReference(
                  project.repoRoot,
                  readMemoryProjectStores(memory).flatMap((store) =>
                    store.entries.map(({ sessionKey, entry }) => [sessionKey, entry] as const),
                  ),
                );
                if (reference) {
                  throw new ProjectCheckoutError(
                    `Project checkout is still referenced by session ${reference}. Remove that reference before deleting the checkout.`,
                  );
                }
              }
            };
            return removeClonedProjectCheckout(
              project,
              async () => {
                assertCurrent();
                const reference = await findProjectCheckoutReference(
                  context.getRuntimeConfig(),
                  project.repoRoot,
                  worktrees,
                  incognitoStores,
                );
                assertCurrent();
                if (reference) {
                  throw new ProjectCheckoutError(
                    `Project checkout is still referenced by ${reference}. Remove that reference before deleting the checkout.`,
                  );
                }
              },
              { assertCurrent },
            );
          };
          removed = memory
            ? await remove([])
            : captureIncognitoSessionBinding()
              ? await withIncognitoSessionStoreEntries(remove)
              : await remove();
        } catch (error) {
          respond(false, undefined, projectCheckoutError(error));
          return;
        }
      } else {
        removed = await removeProjectRegistry(project);
      }
      if (!removed) {
        respondUnknownProject();
        return;
      }
      respond(true, { removed: true }, undefined);
    },
  };
}

export const projectsHandlers = createProjectsHandlers(managedWorktrees);
