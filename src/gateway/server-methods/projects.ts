import path from "node:path";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateProjectsAddParams,
  validateProjectsListParams,
  validateProjectsCheckoutOptionsParams,
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
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../../config/sessions/combined-store-gateway-read.js";
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
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { searchRemoteProjects } from "../project-github-search.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveSessionCreateAgentId } from "../session-request-agent.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { startProjectsListDiagnostics } from "./projects-list-diagnostics.js";
import { listObservedProjects, sanitizeProjectRecord } from "./projects-observed.js";
import { listProjectRecents } from "./projects-recents.js";
import {
  assertMemoryProjectStoresCurrent,
  loadProjectRecentCandidates,
  loadProjectSessionStore,
  readMemoryProjectStores,
  type MemoryProjectStores,
} from "./projects-session-store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

function projectCheckoutError(error: unknown) {
  return errorShape(
    error instanceof ProjectCheckoutError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
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
      (cwd && isPathInside(normalizedRoot, cwd))
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
): Promise<string | undefined> {
  const normalizedRoot = path.resolve(repoRoot);
  const workspaceReference = listWorkspaceProjects(cfg).find(
    (candidate) => path.resolve(candidate.repoRoot) === normalizedRoot,
  );
  const worktreeReference = worktrees.find(
    (worktree) => !worktree.removedAt && path.resolve(worktree.repoRoot) === normalizedRoot,
  );
  const sessionReference = findSessionCheckoutReference(
    normalizedRoot,
    Object.entries(
      (
        await loadCombinedSessionStoreForGatewayCoreAsync(cfg, {
          projection: "list",
          includeIncognito: false,
        })
      ).store,
    ),
  );
  return workspaceReference
    ? `agent workspace ${workspaceReference.displayName}`
    : worktreeReference
      ? `managed worktree ${worktreeReference.name}`
      : sessionReference
        ? `session ${sessionReference}`
        : undefined;
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateProjectsListParams, "projects.list", respond)) {
      return;
    }
    const diagnostics = startProjectsListDiagnostics(context);
    const cfg = context.getRuntimeConfig();
    const defaultRepository = configuredDefaultRepository(cfg);
    const requesterProfileId = client?.authenticatedUserProfile?.profileId;
    const requesterUserId = client?.authenticatedUserId;
    const assertCurrent = () => {
      if (
        client?.authenticatedUserProfile?.profileId !== requesterProfileId ||
        client?.authenticatedUserId !== requesterUserId ||
        context.getRuntimeConfig() !== cfg
      ) {
        throw new Error("Project access changed while preparing the listing. Retry the request.");
      }
    };
    const list = async (
      memoryStores: MemoryProjectStores,
      assertMemoryCurrent: (keys: ReadonlySet<string>) => void,
    ) => {
      const registryProjects = await listProjectRegistry(cfg);
      diagnostics?.mark("sessions");
      const projects = registryProjects.map(sanitizeProjectRecord);
      const canWrite = () =>
        authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, client?.connect.scopes ?? []).allowed;
      let store: Record<string, SessionEntry> = {};
      let projection: ReturnType<typeof getSessionRowProjection>;
      let sessions: ReturnType<typeof loadProjectSessionStore> | undefined;
      let observedProjects: Awaited<ReturnType<typeof listObservedProjects>> | undefined;
      if (client?.authenticatedUserProfile?.profileId || (params.includeObserved && canWrite())) {
        projection = requireSessionRowProjection(context);
      }
      if (params.includeObserved && canWrite() && projection) {
        do {
          await projection.prepareSelection({ metadataOnly: true });
        } while (projection.needsSelectionPreparation({ metadataOnly: true }));
        if (getSessionRowProjection(context) !== projection || projection.state.cfg !== cfg) {
          throw new Error(
            "Session projection changed while preparing the listing. Retry the request.",
          );
        }
        sessions = loadProjectSessionStore(projection, memoryStores);
        store = sessions.store;
      }
      if (params.includeObserved && canWrite()) {
        observedProjects = await listObservedProjects(context, client, store, diagnostics);
      }
      diagnostics?.mark("recents");
      const profileId = client?.authenticatedUserProfile?.profileId;
      const recentProfile = profileId
        ? await prepareCurrentUserProfileAliases(profileId)
        : undefined;
      const recentSessions = new Set<string>();
      const recentCandidates =
        recentProfile && projection
          ? await loadProjectRecentCandidates(projection, memoryStores, recentProfile.aliases)
          : undefined;
      const recents = recentCandidates
        ? await listProjectRecents(recentCandidates.candidates, registryProjects, recentSessions)
        : undefined;
      recentProfile?.assertCurrent();
      diagnostics?.mark("response");
      const writable = canWrite();
      const canCreate = authorizeOperatorScopesForMethod(
        "sessions.create",
        client?.connect.scopes ?? [],
      ).allowed;
      if (
        projection &&
        (getSessionRowProjection(context) !== projection || projection.state.cfg !== cfg)
      ) {
        throw new Error(
          "Session projection changed while preparing the listing. Retry the request.",
        );
      }
      recentCandidates?.assertCurrent(recentSessions);
      if (writable && observedProjects) {
        sessions?.assertCurrent(observedProjects.usedSessions);
        observedProjects.assertCurrent();
      }
      assertMemoryCurrent(
        new Set([
          ...recentSessions,
          ...(writable && observedProjects ? observedProjects.usedSessions : []),
        ]),
      );
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
                recents: writable ? recents : recents.filter((recent) => recent.kind === "project"),
              }
            : {}),
          ...(writable && observedProjects ? { observedProjects: observedProjects.projects } : {}),
        },
        undefined,
      );
    };
    try {
      const stores = readMemoryProjectStores(assertCurrent);
      await list(stores, (keys) => assertMemoryProjectStoresCurrent(stores, keys, assertCurrent));
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    } finally {
      diagnostics?.finish();
    }
  },
  "projects.checkoutOptions": defineValidatedGatewayHandler(
    "projects.checkoutOptions",
    validateProjectsCheckoutOptionsParams,
    async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
      const cfg = context.getRuntimeConfig();
      const profileId = client?.authenticatedUserProfile?.profileId;
      const selected = resolveSessionCreateAgentId(cfg, { agentId: params.agentId });
      if (!selected.ok) {
        respond(false, undefined, selected.error);
        return;
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (
          hasCurrentClientAuthority?.() === false ||
          context.getRuntimeConfig() !== cfg ||
          client?.authenticatedUserProfile?.profileId !== profileId
        ) {
          throw new Error("Project access changed; select the project again.");
        }
      };
      const denied = authorizeGatewaySessionCreation({ cfg, agentId: selected.agentId, client });
      if (denied) {
        respond(false, undefined, denied);
        return;
      }
      assertCurrent();
      const { resolveSessionProjectCheckoutOptions } = await import("../session-project-source.js");
      const options = await resolveSessionProjectCheckoutOptions({
        cfg,
        projectId: params.projectId,
        targetAgentId: selected.agentId,
        resolveSandboxRequired: () =>
          resolveCreatorSandbox(cfg, resolveOperatorSessionCreation(client)) === "required",
        assertCurrent,
        signal,
      });
      assertCurrent();
      const currentDenial = authorizeGatewaySessionCreation({
        cfg,
        agentId: selected.agentId,
        client,
      });
      if (currentDenial) {
        respond(false, undefined, currentDenial);
        return;
      }
      const canCreate = authorizeOperatorScopesForMethod(
        "sessions.create",
        client?.connect.scopes ?? [],
      ).allowed;
      respond(
        true,
        { current: canCreate && options.current, worktree: canCreate && options.worktree },
        undefined,
      );
    },
    () =>
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Checkout availability could not be checked. Select the project again.",
      ),
  ),
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
        ...(cfg.gateway?.projects?.nativeGitHubSearch === true ? { token: nativeToken ?? "" } : {}),
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
        const assertWorktreesCurrent = captureWorktreeRegistryAuthority(worktreeContext, [
          { id: "*", fields: ["identity", "removal"] },
        ]);
        const worktrees = await readRegistryWorktrees(process.env, {}, worktreeContext);
        worktreeContext.admission.assertCurrent();
        assertWorktreesCurrent();
        const remove = () => {
          const assertCurrent = () => {
            worktreeContext.admission.assertCurrent();
            assertWorktreesCurrent();
            const reference = findSessionCheckoutReference(
              project.repoRoot,
              readMemoryProjectStores(() => worktreeContext.admission.assertCurrent()).flatMap(
                (store) =>
                  store.entries.map(({ sessionKey, entry }) => [sessionKey, entry] as const),
              ),
            );
            if (reference) {
              throw new ProjectCheckoutError(
                `Project checkout is still referenced by session ${reference}. Remove that reference before deleting the checkout.`,
              );
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
        removed = await remove();
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
