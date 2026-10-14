import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  RemoteProject,
  ProjectsSearchRemoteResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createStaleWhileRevalidateCache } from "../infra/stale-while-revalidate-cache.js";
import { logWarn } from "../logger.js";
import { parseConfiguredProjectGitUrl } from "../projects/project-git-url.runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { gitHubPublicApi } from "./github-public-api.js";

const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_LIMIT = 100;
const SEARCH_RESULT_LIMIT = 10;
const AFFILIATED_RESULT_LIMIT = 10;
// GitHub owner/repo shapes; an exact match resolves directly instead of relying
// on search ranking (search tokenizes the slash and matches thousands of repos).
const EXACT_REPO_QUERY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

type SearchPage = { projects: RemoteProject[]; etag?: string; credentialScope: string };
const searchCaches = new WeakMap<
  typeof fetch,
  ReturnType<typeof createStaleWhileRevalidateCache<SearchPage>>
>();

function boundedString(value: unknown, maxLength: number): string | undefined {
  return normalizeOptionalString(value)?.slice(0, maxLength);
}

function parseRepository(value: unknown): RemoteProject | null {
  if (!isRecord(value)) {
    return null;
  }
  const fullName = readNonBlankString(value.full_name);
  const name = readNonBlankString(value.name);
  if (!fullName || !name) {
    return null;
  }
  const clone = parseConfiguredProjectGitUrl(readNonBlankString(value.clone_url) ?? "");
  const webUrl = boundedString(value.html_url, 2048);
  if (!clone || !webUrl) {
    return null;
  }
  const description = boundedString(value.description, 500);
  const defaultBranch = boundedString(value.default_branch, 255);
  return {
    name: name.slice(0, 100),
    fullName: fullName.slice(0, 200),
    cloneUrl: clone.url,
    webUrl,
    private: value.private === true,
    ...(description ? { description } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function repositoryArray(value: unknown): RemoteProject[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return items.flatMap((item) => {
    const parsed = parseRepository(item);
    return parsed ? [parsed] : [];
  });
}

function matchesAffiliatedQuery(project: RemoteProject, query: string): boolean {
  const needle = query.toLowerCase();
  return [project.name, project.fullName, project.description ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

type GitHubSearchRequest = (
  url: string,
  options?: { optionalAuth?: boolean; optional?: boolean; single?: boolean },
) => Promise<RemoteProject[]>;

async function loadExactRepository(
  query: string,
  request: GitHubSearchRequest,
): Promise<RemoteProject | null> {
  const url = new URL(`repos/${query}`, `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  return (await request(url.href, { optional: true, single: true }))[0] ?? null;
}

async function loadAffiliatedRepositories(request: GitHubSearchRequest): Promise<RemoteProject[]> {
  const url = new URL("user/repos", `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(AFFILIATED_RESULT_LIMIT));
  return request(url.href, { optional: true, optionalAuth: false });
}

async function loadRepositorySearch(
  query: string,
  request: GitHubSearchRequest,
): Promise<RemoteProject[]> {
  const url = new URL("search/repositories", `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  url.searchParams.set("q", `${query} in:name,description`);
  url.searchParams.set("per_page", String(SEARCH_RESULT_LIMIT));
  return request(url.href);
}

async function searchProjectsUncached(params: {
  query: string;
  request: GitHubSearchRequest;
  token?: string;
}): Promise<ProjectsSearchRemoteResult> {
  const [exact, affiliated, global] = await Promise.all([
    EXACT_REPO_QUERY.test(params.query) ? loadExactRepository(params.query, params.request) : null,
    params.token ? loadAffiliatedRepositories(params.request) : [],
    loadRepositorySearch(params.query, params.request),
  ]);
  // Order is the ranking: exact owner/name hit, then affiliated repositories
  // (API-sorted by recency), then global search in GitHub best-match order.
  const ranked = [
    ...(exact ? [exact] : []),
    ...affiliated.filter((project) => matchesAffiliatedQuery(project, params.query)),
    ...global,
  ];
  const deduped = new Map<string, RemoteProject>();
  for (const project of ranked) {
    const key = project.fullName.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, project);
    }
  }
  return {
    credential: params.token ? "configured" : "missing",
    projects: [...deduped.values()].slice(0, SEARCH_RESULT_LIMIT),
  };
}

/** Searches affiliated and public GitHub repositories for the project picker. */
export async function searchRemoteProjects(
  query: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    token?: string;
    host?: string;
    apiBaseUrl?: string;
    assertCurrent?: () => void;
    trackExecution?: <T>(run: () => Promise<T>) => Promise<T>;
    signal?: AbortSignal;
  } = {},
): Promise<ProjectsSearchRemoteResult> {
  const config = getRuntimeConfigSnapshot();
  const host = options.host ?? resolveConfiguredGitHubHost(config);
  const apiBaseUrl = options.apiBaseUrl ?? resolveConfiguredGitHubApiBaseUrl(config);
  const assertCurrent = () => {
    options.assertCurrent?.();
    const current = getRuntimeConfigSnapshot();
    if (
      resolveConfiguredGitHubHost(current) !== host ||
      resolveConfiguredGitHubApiBaseUrl(current) !== apiBaseUrl ||
      gitHubPublicApi.GITHUB_API_BASE_URL !== apiBaseUrl
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        502,
        "GitHub host changed during project search",
      );
    }
  };
  const assertSelected = () => {
    options.signal?.throwIfAborted();
    assertCurrent();
  };
  assertSelected();
  const { token, cacheScope } =
    options.token === undefined
      ? gitHubPublicApi.resolveGitHubApiCredentialScope(options.env)
      : {
          token: options.token,
          cacheScope: gitHubPublicApi.githubApiCredentialCacheScope(options.token),
        };
  const assertTransportCurrent = () => {
    assertCurrent();
    if (
      options.token === undefined &&
      gitHubPublicApi.resolveGitHubApiCredentialScope(options.env).cacheScope !== cacheScope
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(409, "GitHub identity changed during search");
    }
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache =
    searchCaches.get(fetchImpl) ??
    createStaleWhileRevalidateCache<SearchPage>({
      maxEntries: SEARCH_CACHE_LIMIT,
      ttlMs: SEARCH_CACHE_MS,
      onBackgroundError: () => logWarn("projects: GitHub repository search refresh failed"),
    });
  searchCaches.set(fetchImpl, cache);
  let stale = false;
  const request: GitHubSearchRequest = async (
    url,
    { optionalAuth = true, optional, single } = {},
  ) => {
    const identity = {
      assertSelected: assertTransportCurrent,
      revalidate: async () => assertTransportCurrent(),
    };
    // Cache the actual page so distinct queries share affiliated repositories.
    const result = await cache
      .read(`${url}\0${host}\0${cacheScope}`, (previous) => {
        const load = async (): Promise<SearchPage> => {
          const readJson = async (requestToken: string | undefined): Promise<SearchPage> => {
            assertTransportCurrent();
            const credentialScope = gitHubPublicApi.githubApiCredentialCacheScope(requestToken);
            const cached = previous?.credentialScope === credentialScope ? previous : undefined;
            const response = await gitHubPublicApi.fetchGitHubApi(
              url,
              fetchImpl,
              requestToken,
              undefined,
              identity,
              cached?.etag,
              getAsyncWorkSignal(),
              undefined,
              apiBaseUrl,
            );
            if (response.status === 304 && cached?.etag) {
              await gitHubPublicApi.discardResponse(response);
              assertTransportCurrent();
              return cached;
            }
            const value = await gitHubPublicApi.readGitHubJsonResponse(response);
            const repository = single ? parseRepository(value) : null;
            const projects = single ? (repository ? [repository] : []) : repositoryArray(value);
            assertTransportCurrent();
            return { projects, etag: response.headers.get("etag") ?? undefined, credentialScope };
          };
          try {
            return await (optionalAuth
              ? gitHubPublicApi.withOptionalGitHubAuth(token, readJson)
              : readJson(token));
          } catch (error) {
            assertTransportCurrent();
            if (!optional) {
              throw error;
            }
            // Failed enrichment stays quiet for the same TTL as successful pages.
            return {
              projects: [],
              credentialScope: gitHubPublicApi.githubApiCredentialCacheScope(token),
            };
          }
        };
        return options.trackExecution?.(load) ?? load();
      })
      .catch((error: unknown) => {
        // A shared enrichment load may lose its initiating caller. Each follower
        // still checks its own authority before degrading to global search.
        assertTransportCurrent();
        if (!optional) {
          throw error;
        }
        return undefined;
      });
    stale ||= result?.stale ?? false;
    return result?.value.projects ?? [];
  };
  try {
    // The Gateway owns refresh work; each dispatch still requires its initiating authority.
    const result = await racePromiseWithAbortSignal(
      searchProjectsUncached({ query: query.trim().toLowerCase(), request, token }),
      options.signal,
    );
    assertTransportCurrent();
    return stale ? { ...result, stale: true } : result;
  } finally {
    assertSelected();
  }
}
