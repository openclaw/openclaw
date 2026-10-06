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
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseConfiguredProjectGitUrl } from "../projects/project-git-url.runtime.js";
import { createGitHubReadGroup } from "./control-ui-session-pr-request.js";
import { gitHubPublicApi } from "./github-public-api.js";

const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_LIMIT = 100;
const SEARCH_RESULT_LIMIT = 10;
const AFFILIATED_RESULT_LIMIT = 10;
// GitHub owner/repo shapes; an exact match resolves directly instead of relying
// on search ranking (search tokenizes the slash and matches thousands of repos).
const EXACT_REPO_QUERY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

type SearchCacheEntry = {
  expiresAt: number;
  access: ReturnType<typeof createGitHubReadGroup>;
  promise: Promise<ProjectsSearchRemoteResult>;
};

const searchCache = new Map<string, SearchCacheEntry>();

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

type GitHubSearchRequest = (url: string, optionalAuth?: boolean) => Promise<unknown>;

async function loadExactRepository(
  query: string,
  request: GitHubSearchRequest,
): Promise<RemoteProject | null> {
  const url = new URL(`repos/${query}`, `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  // Optional enrichment lane: a miss, API error, or transport rejection must
  // degrade to search-only results, never sink the whole picker query.
  try {
    return parseRepository(await request(url.href));
  } catch {
    return null;
  }
}

async function loadAffiliatedRepositories(request: GitHubSearchRequest): Promise<RemoteProject[]> {
  const url = new URL("user/repos", `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(AFFILIATED_RESULT_LIMIT));
  // Optional enrichment lane: see loadExactRepository — failures degrade to
  // global-search-only results instead of failing the picker query.
  try {
    return repositoryArray(await request(url.href, false));
  } catch {
    return [];
  }
}

async function loadRepositorySearch(
  query: string,
  request: GitHubSearchRequest,
): Promise<RemoteProject[]> {
  const url = new URL("search/repositories", `${gitHubPublicApi.GITHUB_API_BASE_URL}/`);
  url.searchParams.set("q", `${query} in:name,description`);
  url.searchParams.set("per_page", String(SEARCH_RESULT_LIMIT));
  return repositoryArray(await request(url.href));
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
    now?: number;
    token?: string;
    host?: string;
    apiBaseUrl?: string;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  } = {},
): Promise<ProjectsSearchRemoteResult> {
  const config = getRuntimeConfigSnapshot();
  const host = options.host ?? resolveConfiguredGitHubHost(config);
  const apiBaseUrl = options.apiBaseUrl ?? resolveConfiguredGitHubApiBaseUrl(config);
  const assertSelected = () => {
    options.signal?.throwIfAborted();
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
  assertSelected();
  const normalizedQuery = query.trim().toLowerCase();
  const { token, cacheScope } =
    options.token === undefined
      ? gitHubPublicApi.resolveGitHubApiCredentialScope(options.env)
      : {
          token: options.token,
          cacheScope: gitHubPublicApi.githubApiCredentialCacheScope(options.token),
        };
  // Gateway reloads run in-process, so cache results must stay credential-scoped.
  const cacheKey = `${normalizedQuery}\0${host}\0${apiBaseUrl}\0${cacheScope}`;
  const now = options.now ?? Date.now();
  const cached = searchCache.get(cacheKey);
  const reusable = cached && cached.expiresAt > now && !cached.access.signal.aborted;
  const entry: SearchCacheEntry = reusable
    ? cached
    : {
        expiresAt: now + SEARCH_CACHE_MS,
        access: createGitHubReadGroup(),
        promise: Promise.resolve({ credential: "missing", projects: [] }),
      };
  const release = entry.access.add(assertSelected, options.signal);
  if (!reusable) {
    // Keep transport identity stable so the API owner retains quota cooldowns.
    // The coalesced reader group owns per-request authority and cancellation.
    const fetchImpl = options.fetchImpl ?? fetch;
    const identity = {
      assertSelected: entry.access.assertCurrent,
      revalidate: async () => entry.access.assertCurrent(),
    };
    const request: GitHubSearchRequest = (url, optionalAuth = true) => {
      const readJson = async (requestToken: string | undefined) =>
        gitHubPublicApi.readGitHubJsonResponse(
          await gitHubPublicApi.fetchGitHubApi(
            url,
            fetchImpl,
            requestToken,
            undefined,
            identity,
            undefined,
            entry.access.signal,
            undefined,
            apiBaseUrl,
          ),
        );
      return optionalAuth
        ? gitHubPublicApi.withOptionalGitHubAuth(token, readJson)
        : readJson(token);
    };
    entry.promise = searchProjectsUncached({ query: query.trim(), request, token }).catch(
      (error: unknown) => {
        if (searchCache.get(cacheKey) === entry) {
          searchCache.delete(cacheKey);
        }
        throw error;
      },
    );
  }
  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, entry);
  pruneMapToMaxSize(searchCache, SEARCH_CACHE_LIMIT);
  try {
    return await racePromiseWithAbortSignal(entry.promise, options.signal);
  } finally {
    release();
    assertSelected();
  }
}
