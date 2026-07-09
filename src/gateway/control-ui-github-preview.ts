// Same-origin GitHub metadata adapter for Control UI link previews.
import { readResponseWithLimit } from "../infra/http-body.js";
import type { ControlUiGitHubPreview } from "./control-ui-contract.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_JSON_MAX_BYTES = 256 * 1024;
const GITHUB_AVATAR_MAX_BYTES = 256 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_API_MAX_REDIRECTS = 3;
const AUTHENTICATED_SUCCESS_CACHE_MS = 5 * 60_000;
const ANONYMOUS_SUCCESS_CACHE_MS = 60 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 200;

type GitHubLinkKind = "issue" | "pull";

export type ControlUiGitHubPreviewTarget = {
  kind: GitHubLinkKind;
  number: number;
  owner: string;
  repo: string;
};

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const previewCache = new Map<string, CacheEntry<ControlUiGitHubPreview>>();

export class ControlUiGitHubPreviewError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ControlUiGitHubPreviewError";
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlUiGitHubPreviewError(502, `GitHub response omitted ${key}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isValidOwner(value: string): boolean {
  return /^(?=.{1,39}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(value);
}

function isValidRepo(value: string): boolean {
  return value !== "." && value !== ".." && /^[a-z\d_.-]{1,100}$/iu.test(value);
}

export function parseControlUiGitHubPreviewTarget(
  value: unknown,
): ControlUiGitHubPreviewTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const number = value.number;
  if (
    (kind !== "issue" && kind !== "pull") ||
    !isValidOwner(owner) ||
    !isValidRepo(repo) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 9_999_999_999
  ) {
    return null;
  }
  return { kind, number, owner, repo };
}

function previewApiUrl(target: ControlUiGitHubPreviewTarget): string {
  const collection = target.kind === "pull" ? "pulls" : "issues";
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/${collection}/${target.number}`;
}

function repositoryApiUrl(target: ControlUiGitHubPreviewTarget): string {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}`;
}

function githubApiToken(): string | undefined {
  return process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw-Control-UI",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isGitHubApiRedirect(status: number): boolean {
  return (
    status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  );
}

function safeGitHubApiUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base);
    if (
      url.origin !== GITHUB_API_ORIGIN ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function fetchGitHubApi(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  beforeRedirect?: (url: URL) => Promise<void>,
): Promise<Response> {
  const initialUrl = safeGitHubApiUrl(rawUrl);
  if (!initialUrl) {
    throw new ControlUiGitHubPreviewError(502, "Invalid GitHub API URL");
  }
  let url: URL = initialUrl;

  const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  for (let redirects = 0; ; redirects += 1) {
    const response: Response = await fetchImpl(url.href, {
      headers: githubApiHeaders(token),
      redirect: "manual",
      signal,
    });
    if (!isGitHubApiRedirect(response.status)) {
      return response;
    }

    const location: string | null = response.headers.get("location");
    const nextUrl: URL | null = location ? safeGitHubApiUrl(location, url) : null;
    if (!nextUrl || redirects >= GITHUB_API_MAX_REDIRECTS) {
      await discardResponse(response);
      throw new ControlUiGitHubPreviewError(502, "GitHub API returned an unsafe redirect");
    }
    // Credentials stay on the fixed API origin across GitHub redirects;
    // callers still verify the final response repository before returning it.
    await discardResponse(response);
    await beforeRedirect?.(nextUrl);
    url = nextUrl;
  }
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readResponseWithLimit(response, maxBytes);
  } finally {
    await discardResponse(response);
  }
}

function upstreamErrorStatus(status: number): number {
  if (status === 404) {
    return 404;
  }
  if (status === 403 || status === 429) {
    return 429;
  }
  return 502;
}

async function assertPublicRepositoryUrl(
  repositoryUrl: string,
  fetchImpl: typeof fetch,
  token: string,
): Promise<void> {
  // Private and missing repositories stop at this same request boundary before
  // any item fetch, so operator.read callers cannot probe private item numbers.
  const response = await fetchGitHubApi(repositoryUrl, fetchImpl, token);
  if (!response.ok) {
    await discardResponse(response);
    throw new ControlUiGitHubPreviewError(
      upstreamErrorStatus(response.status),
      `GitHub repository request failed (${response.status})`,
    );
  }
  const body = await readBoundedResponse(response, GITHUB_JSON_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubPreviewError(502, "GitHub repository response was not valid JSON");
  }
  if (!isRecord(parsed) || parsed.private !== false) {
    throw new ControlUiGitHubPreviewError(404, "GitHub repository is not public");
  }
}

function redirectedRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  url: URL,
): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const collection = target.kind === "pull" ? "pulls" : "issues";
  if (
    segments.length === 5 &&
    segments[0] === "repos" &&
    segments[1] &&
    segments[2] &&
    segments[3] === collection &&
    /^\d+$/u.test(segments[4] ?? "")
  ) {
    return `${GITHUB_API_ORIGIN}/repos/${segments[1]}/${segments[2]}`;
  }
  if (
    segments.length === 4 &&
    segments[0] === "repositories" &&
    /^\d+$/u.test(segments[1] ?? "") &&
    segments[2] === collection &&
    /^\d+$/u.test(segments[3] ?? "")
  ) {
    return `${GITHUB_API_ORIGIN}/repositories/${segments[1]}`;
  }
  return null;
}

function previewRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  value: Record<string, unknown>,
): string {
  if (target.kind === "issue") {
    return requiredString(value, "repository_url");
  }
  const base = isRecord(value.base) ? value.base : {};
  const repository = isRecord(base.repo) ? base.repo : {};
  return requiredString(repository, "url");
}

function parseGitHubResponse(
  target: ControlUiGitHubPreviewTarget,
  value: unknown,
): { preview: ControlUiGitHubPreview; avatarUrl?: string } {
  if (!isRecord(value)) {
    throw new ControlUiGitHubPreviewError(502, "GitHub response was not an object");
  }
  const user = isRecord(value.user) ? value.user : {};
  return {
    preview: {
      ...target,
      additions: optionalNumber(value, "additions"),
      changedFiles: optionalNumber(value, "changed_files"),
      closedAt: optionalString(value, "closed_at"),
      comments: optionalNumber(value, "comments"),
      createdAt: requiredString(value, "created_at"),
      deletions: optionalNumber(value, "deletions"),
      draft: typeof value.draft === "boolean" ? value.draft : undefined,
      login: optionalString(user, "login") ?? "ghost",
      mergedAt: optionalString(value, "merged_at"),
      state: requiredString(value, "state"),
      stateReason: optionalString(value, "state_reason"),
      title: requiredString(value, "title"),
      updatedAt: requiredString(value, "updated_at"),
    },
    avatarUrl: optionalString(user, "avatar_url"),
  };
}

function safeAvatarUrl(raw: string | undefined): URL | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== GITHUB_AVATAR_HOST ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    url.searchParams.set("s", "64");
    return url;
  } catch {
    return null;
  }
}

async function fetchAvatarDataUrl(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const url = safeAvatarUrl(rawUrl);
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      !response.ok ||
      !contentType ||
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(contentType)
    ) {
      await discardResponse(response);
      return undefined;
    }
    const body = await readBoundedResponse(response, GITHUB_AVATAR_MAX_BYTES);
    return `data:${contentType};base64,${body.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function fetchPreview(
  target: ControlUiGitHubPreviewTarget,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<ControlUiGitHubPreview> {
  if (token) {
    await assertPublicRepositoryUrl(repositoryApiUrl(target), fetchImpl, token);
  }
  const response = await fetchGitHubApi(
    previewApiUrl(target),
    fetchImpl,
    token,
    token
      ? async (url) => {
          const repositoryUrl = redirectedRepositoryApiUrl(target, url);
          if (!repositoryUrl) {
            throw new ControlUiGitHubPreviewError(502, "GitHub item returned an unsafe redirect");
          }
          await assertPublicRepositoryUrl(repositoryUrl, fetchImpl, token);
        }
      : undefined,
  );
  if (!response.ok) {
    await discardResponse(response);
    throw new ControlUiGitHubPreviewError(
      upstreamErrorStatus(response.status),
      `GitHub request failed (${response.status})`,
    );
  }
  const body = await readBoundedResponse(response, GITHUB_JSON_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubPreviewError(502, "GitHub response was not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ControlUiGitHubPreviewError(502, "GitHub response was not an object");
  }
  if (token) {
    await assertPublicRepositoryUrl(previewRepositoryApiUrl(target, parsed), fetchImpl, token);
  }
  const { preview, avatarUrl } = parseGitHubResponse(target, parsed);
  const avatarDataUrl = await fetchAvatarDataUrl(avatarUrl, fetchImpl);
  return avatarDataUrl ? { ...preview, avatarDataUrl } : preview;
}

function cacheKey(target: ControlUiGitHubPreviewTarget): string {
  return `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
}

export function loadControlUiGitHubPreview(
  target: ControlUiGitHubPreviewTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<ControlUiGitHubPreview> {
  const key = cacheKey(target);
  const now = Date.now();
  const cached = previewCache.get(key);
  if (cached && cached.expiresAt > now) {
    previewCache.delete(key);
    previewCache.set(key, cached);
    return cached.promise;
  }
  if (cached) {
    previewCache.delete(key);
  }

  const token = githubApiToken();
  const successCacheMs = token ? AUTHENTICATED_SUCCESS_CACHE_MS : ANONYMOUS_SUCCESS_CACHE_MS;
  const entry: CacheEntry<ControlUiGitHubPreview> = {
    expiresAt: now + successCacheMs,
    promise: fetchPreview(target, fetchImpl, token).catch((error: unknown) => {
      // Short failure caching protects the anonymous GitHub quota when a user
      // repeatedly crosses a private, missing, or rate-limited link.
      entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
      throw error;
    }),
  };
  previewCache.set(key, entry);
  while (previewCache.size > CACHE_LIMIT) {
    const oldestKey = previewCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    previewCache.delete(oldestKey);
  }
  return entry.promise;
}
