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
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";

/**
 * Who asks for a registry project's source. Gateway-internal callers (owner runs,
 * cron, migrations, maintenance) keep full access; identified operators are bound
 * by their connection or role scopes.
 */
export type ProjectRequester =
  | { readonly kind: "internal" }
  | { readonly kind: "operator"; readonly scopes: readonly string[] };

export const INTERNAL_PROJECT_REQUESTER: ProjectRequester = Object.freeze({ kind: "internal" });

export function operatorProjectRequester(scopes: readonly string[] | undefined): ProjectRequester {
  return { kind: "operator", scopes: scopes ?? [] };
}

/** Client-less dispatch is Gateway-internal; connected operators are bound by their scopes. */
export function projectRequesterForClient(
  client: { connect?: { scopes?: readonly string[] } } | null | undefined,
): ProjectRequester {
  return client ? operatorProjectRequester(client.connect?.scopes) : INTERNAL_PROJECT_REQUESTER;
}

/**
 * Background runs act for the operator that drove them (effective scopes, including
 * membership caps). Without one they fall back to the creator's live role; runs with
 * neither (owner, cron, unlinked channels) stay internal.
 */
export function resolveRunProjectRequester(
  cfg: OpenClawConfig,
  spawnedBy: { profileId?: string; operatorScopes?: readonly string[] },
): ProjectRequester {
  if (spawnedBy.operatorScopes) {
    return operatorProjectRequester(spawnedBy.operatorScopes);
  }
  const policy = spawnedBy.profileId
    ? resolveOperatorRolePolicyForProfile(spawnedBy.profileId, cfg)
    : undefined;
  return policy ? operatorProjectRequester(policy.scopes) : INTERNAL_PROJECT_REQUESTER;
}

/** operator.write callers may use every registry project; restricted roles see a subset. */
export function hasFullProjectAccess(requester: ProjectRequester): boolean {
  return (
    requester.kind === "internal" ||
    authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, requester.scopes).allowed
  );
}

// Visibility changes are rare; the picker may lag by this TTL while every source
// handoff (session creation, spawns, inherited children) asks GitHub again.
const VISIBILITY_TTL_MS = 10 * 60_000;
const VISIBILITY_CACHE_LIMIT = 1_000;
const visibilityCache = new Map<string, { isPublic: boolean; expiresAt: number }>();
const visibilityLoads = new Map<string, Promise<boolean>>();

export type ProjectAccessOptions = {
  /** Skip the cached answer; use where source is handed out. */
  fresh?: boolean;
  fetchImpl?: typeof fetch;
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
  fetchImpl: typeof fetch;
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
      params.fetchImpl,
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
  const inFlight = visibilityLoads.get(key);
  if (inFlight) {
    return await inFlight;
  }
  const load = loadRepositoryIsPublic({
    cfg,
    apiBaseUrl,
    fullName,
    key,
    fetchImpl: options.fetchImpl ?? fetch,
  }).finally(() => visibilityLoads.delete(key));
  visibilityLoads.set(key, load);
  return await load;
}

/**
 * Restricted requesters may use agent-workspace pseudo-projects (governed by
 * roles.agents) and public GitHub repositories on the configured host.
 */
export async function canRequesterUseProject(
  cfg: OpenClawConfig,
  project: Pick<ProjectRegistryIdentity, "source" | "originUrl">,
  requester: ProjectRequester,
  options: ProjectAccessOptions = {},
): Promise<boolean> {
  if (hasFullProjectAccess(requester) || project.source === "workspace") {
    return true;
  }
  return await isPublicGitHubOrigin(cfg, project.originUrl, options);
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

export async function filterProjectsForRequester<
  T extends Pick<ProjectRegistryIdentity, "source" | "originUrl">,
>(
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

export function resetProjectVisibilityCacheForTest(): void {
  visibilityCache.clear();
  visibilityLoads.clear();
}
