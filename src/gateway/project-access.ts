import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";
import { resolveProjectRegistry } from "../projects/project-registry.js";
import type {
  ProjectRegistryIdentity,
  ProjectRegistryRecord,
} from "../projects/project-registry.types.js";
import { gitHubPublicApi, githubApiToken } from "./github-public-api.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import type { OpenClawIdTunnelPrincipal } from "./openclaw-id/tunnel-principal.js";
import {
  resolveCurrentProjectGrant,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** A named role's registry project grant: every project, or the listed project IDs. */
type ProjectGrant = "*" | readonly string[];

/**
 * Who asks for a registry project's source. Gateway-internal callers (owner runs,
 * cron, migrations, maintenance) keep full access; identified operators are bound
 * by their connection or role scopes and their current role's project grant.
 */
export type ProjectRequester =
  | { readonly kind: "internal" }
  | {
      readonly kind: "operator";
      readonly scopes: readonly string[];
      readonly projects?: ProjectGrant;
    };

const INTERNAL_PROJECT_REQUESTER: ProjectRequester = Object.freeze({ kind: "internal" });

/** operator.write callers may use every registry project; restricted roles see a subset. */
export function hasFullProjectAccess(requester: ProjectRequester): boolean {
  return (
    requester.kind === "internal" ||
    authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, requester.scopes).allowed
  );
}

/** Only restricted operators resolve a grant; full-access callers never consult their role. */
function operatorProjectRequester(
  scopes: readonly string[] | undefined,
  resolveProjects: () => ProjectGrant | undefined,
): ProjectRequester {
  const requester = { kind: "operator" as const, scopes: scopes ?? [] };
  if (hasFullProjectAccess(requester)) {
    return requester;
  }
  const projects = resolveProjects();
  return projects ? { ...requester, projects } : requester;
}

/** Client-less dispatch is Gateway-internal; connected operators are bound by their scopes and role. */
export function projectRequesterForClient(
  client: GatewayClient | null | undefined,
  cfg: OpenClawConfig,
): ProjectRequester {
  return client
    ? operatorProjectRequester(client.connect?.scopes, () =>
        resolveCurrentProjectGrant(cfg, { client }),
      )
    : INTERNAL_PROJECT_REQUESTER;
}

/** A profile-attributed operator outside a live connection carries its current role's grant. */
export function projectRequesterForProfile(
  cfg: OpenClawConfig,
  scopes: readonly string[],
  profileId: string | undefined,
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal,
): ProjectRequester {
  return operatorProjectRequester(scopes, () =>
    profileId ? resolveCurrentProjectGrant(cfg, { profileId, openclawIdPrincipal }) : undefined,
  );
}

/**
 * Background runs act for the operator that drove them (effective scopes, including
 * membership caps, plus that person's live project grant). Without one they fall back
 * to the creator's live role; runs with neither (owner, cron, unlinked channels) stay internal.
 */
export function resolveRunProjectRequester(
  cfg: OpenClawConfig,
  spawnedBy: {
    profileId?: string;
    operatorAuthority?: {
      readonly profileId: string;
      readonly scopes: readonly string[];
      readonly openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
    };
  },
): ProjectRequester {
  const authority = spawnedBy.operatorAuthority;
  if (authority) {
    return projectRequesterForProfile(
      cfg,
      authority.scopes,
      authority.profileId,
      authority.openclawIdPrincipal,
    );
  }
  const policy = spawnedBy.profileId
    ? resolveOperatorRolePolicyForProfile(spawnedBy.profileId, cfg)
    : undefined;
  return policy
    ? projectRequesterForProfile(cfg, policy.scopes, spawnedBy.profileId)
    : INTERNAL_PROJECT_REQUESTER;
}

function isProjectGranted(requester: ProjectRequester, projectId: string): boolean {
  const grant = requester.kind === "operator" ? requester.projects : undefined;
  return grant === "*" || grant?.includes(projectId) === true;
}

// Visibility changes are rare; the picker may lag by this TTL while every source
// handoff (session creation, spawns, inherited children) asks GitHub again.
const VISIBILITY_TTL_MS = 10 * 60_000;
const VISIBILITY_CACHE_LIMIT = 1_000;
const visibilityCache = new Map<string, { isPublic: boolean; expiresAt: number }>();

export type ProjectAccessOptions = {
  /** Skip the cached answer; use where source is handed out. */
  fresh?: boolean;
};

function cacheVisibility(key: string, isPublic: boolean): void {
  visibilityCache.delete(key);
  if (visibilityCache.size >= VISIBILITY_CACHE_LIMIT) {
    visibilityCache.delete(visibilityCache.keys().next().value!);
  }
  visibilityCache.set(key, { isPublic, expiresAt: Date.now() + VISIBILITY_TTL_MS });
}

async function loadRepositoryIsPublic(params: {
  cfg: OpenClawConfig;
  apiBaseUrl: string;
  fullName: string;
  key: string;
}): Promise<boolean> {
  let token: string | undefined;
  try {
    token = githubApiToken(process.env, params.cfg);
  } catch {
    // An unavailable service credential falls back to anonymous public reads.
    token = undefined;
  }
  try {
    const value = await gitHubPublicApi.fetchGitHubJson(
      new URL(`repos/${params.fullName}`, `${params.apiBaseUrl}/`).href,
      fetch,
      token,
      undefined,
      params.apiBaseUrl,
    );
    // GitHub Enterprise "internal" and "private" both stay hidden.
    const isPublic = isRecord(value) && value.visibility === "public";
    cacheVisibility(params.key, isPublic);
    return isPublic;
  } catch (error) {
    if (isRecord(error) && error.statusCode === 404) {
      cacheVisibility(params.key, false);
    }
    // Rate limits, outages and other unknown answers deny without caching.
    return false;
  }
}

/** Public-only GitHub visibility for an origin on the configured host; unknown denies. */
async function isPublicGitHubOrigin(
  cfg: OpenClawConfig,
  originUrl: string | undefined,
  options: ProjectAccessOptions,
): Promise<boolean> {
  // The canonical clone parser drops HTTPS ports; a different endpoint cannot
  // borrow the configured service's visibility answer. Default :443 normalizes away.
  const origin = originUrl ? URL.parse(originUrl) : null;
  if (origin?.protocol === "https:" && origin.port) {
    return false;
  }
  const repository = originUrl
    ? parseProjectGitUrl(originUrl, resolveConfiguredGitHubHost(cfg))
    : null;
  if (!repository) {
    return false;
  }
  const fullName = new URL(repository.url).pathname.slice(1, -4);
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(cfg);
  // A rename or transfer changes the key, so it is always a fresh lookup.
  const key = `${apiBaseUrl}\0${fullName.toLowerCase()}`;
  const cached = visibilityCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) {
    return cached.isPublic;
  }
  return await loadRepositoryIsPublic({ cfg, apiBaseUrl, fullName, key });
}

type ProjectAccessTarget = Pick<ProjectRegistryIdentity, "id" | "source" | "originUrl">;

/**
 * Restricted requesters may use agent-workspace pseudo-projects (governed by
 * roles.agents), public GitHub repositories on the configured host, and
 * registry projects their role grants.
 */
export async function canRequesterUseProject(
  cfg: OpenClawConfig,
  project: ProjectAccessTarget,
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<boolean> {
  if (
    hasFullProjectAccess(requester) ||
    project.source === "workspace" ||
    isProjectGranted(requester, project.id)
  ) {
    return true;
  }
  return await isPublicGitHubOrigin(cfg, project.originUrl, options);
}

/**
 * Why a requester may use a project. `"granted"` means a role grant alone admits it,
 * so its source is handed out only as an isolated managed worktree.
 */
export async function resolveProjectAccess(
  cfg: OpenClawConfig,
  project: ProjectAccessTarget,
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<"full" | "public" | "granted" | undefined> {
  if (hasFullProjectAccess(requester) || project.source === "workspace") {
    return "full";
  }
  if (await isPublicGitHubOrigin(cfg, project.originUrl, options)) {
    return "public";
  }
  return isProjectGranted(requester, project.id) ? "granted" : undefined;
}

/** Repository URLs follow the same public-only rule as registered projects. */
export async function canRequesterUseRepositoryUrl(
  cfg: OpenClawConfig,
  url: string,
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<boolean> {
  return hasFullProjectAccess(requester) || (await isPublicGitHubOrigin(cfg, url, options));
}

/** Hidden projects are indistinguishable from unknown ids. */
export async function resolveRequesterProject(
  cfg: OpenClawConfig,
  projectId: string,
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<ProjectRegistryRecord | undefined> {
  const project = await resolveProjectRegistry(cfg, projectId);
  return project && (await canRequesterUseProject(cfg, project, requester, options))
    ? project
    : undefined;
}

export async function filterProjectsForRequester<T extends ProjectAccessTarget>(
  cfg: OpenClawConfig,
  projects: readonly T[],
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<T[]> {
  if (hasFullProjectAccess(requester)) {
    return [...projects];
  }
  const allowed = await Promise.all(
    projects.map((project) => canRequesterUseProject(cfg, project, requester, options)),
  );
  return projects.filter((_, index) => allowed[index]);
}
