import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { parseSemver } from "./runtime-guard.js";
import type { UpdateChannel } from "./update-channels.js";

export type RegistryTagInfo = {
  tag: string;
  version: string;
};

export type DockerRegistryResult = {
  /** Available tags sorted newest-first. */
  tags: RegistryTagInfo[];
  /** The latest version matching the requested channel. */
  latestVersion: string | null;
  /** The tag string for the latest version. */
  latestTag: string | null;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 5000;
const GHCR_REGISTRY = "ghcr.io";
const DEFAULT_IMAGE_NAME = "openclaw/openclaw";

/**
 * Pre-release suffixes that indicate non-stable releases.
 * A tag is considered stable if it does not contain any of these.
 */
const PRERELEASE_PATTERNS = ["-beta", "-alpha", "-rc", "-dev"] as const;

/**
 * Fetch an anonymous bearer token for the ghcr.io registry.
 *
 * ghcr.io implements the Docker Registry v2 token authentication flow:
 * 1. GET the registry and receive a 401 with a Www-Authenticate challenge
 * 2. Exchange for a token at the token endpoint
 *
 * For public images, no credentials are required.
 */
export async function fetchGhcrToken(params: {
  imageName?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<{ token: string | null; error?: string }> {
  const imageName = params.imageName ?? DEFAULT_IMAGE_NAME;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = params.fetchFn;

  const tokenUrl = `https://${GHCR_REGISTRY}/token?scope=repository:${encodeURIComponent(imageName)}:pull&service=${GHCR_REGISTRY}`;

  try {
    const res = await fetchWithTimeout(tokenUrl, {}, timeoutMs, fetchFn);
    if (!res.ok) {
      return { token: null, error: `token exchange HTTP ${res.status}` };
    }
    const json = (await res.json()) as { token?: string };
    const token = typeof json?.token === "string" ? json.token : null;
    return { token, error: token ? undefined : "no token in response" };
  } catch (err) {
    return { token: null, error: String(err) };
  }
}

/**
 * Fetch the list of tags from the ghcr.io container registry for the given image.
 *
 * Uses the OCI Distribution Spec tag list endpoint:
 * `GET /v2/{name}/tags/list`
 */
export async function fetchRegistryTags(params: {
  imageName?: string;
  token: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<{ tags: string[]; error?: string }> {
  const imageName = params.imageName ?? DEFAULT_IMAGE_NAME;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = params.fetchFn;

  const url = `https://${GHCR_REGISTRY}/v2/${imageName}/tags/list`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          Accept: "application/json",
        },
      },
      timeoutMs,
      fetchFn,
    );
    if (!res.ok) {
      return { tags: [], error: `tags list HTTP ${res.status}` };
    }
    const json = (await res.json()) as { tags?: unknown };
    if (!Array.isArray(json?.tags)) {
      return { tags: [], error: "unexpected tags response shape" };
    }
    const tags = (json.tags as unknown[]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    return { tags };
  } catch (err) {
    return { tags: [], error: String(err) };
  }
}

/**
 * Check if a tag string looks like a semver version (e.g. "1.2.3", "v1.2.3-beta.1").
 */
function isSemverTag(tag: string): boolean {
  return parseSemver(tag) !== null;
}

/**
 * Check if a tag is a stable release (no pre-release suffix).
 */
function isStableRelease(tag: string): boolean {
  const lower = tag.toLowerCase();
  return PRERELEASE_PATTERNS.every((p) => !lower.includes(p));
}

/**
 * Check if a tag matches the given update channel.
 *
 * - `stable`: only tags without pre-release suffixes
 * - `beta`: all semver tags (including beta, rc, alpha)
 * - `dev`: all semver tags
 */
function matchesChannel(tag: string, channel: UpdateChannel): boolean {
  if (channel === "stable") {
    return isStableRelease(tag);
  }
  // Beta and dev channels accept all semver tags
  return true;
}

/**
 * Compare two semver version strings. Returns negative if a < b, positive if a > b, 0 if equal.
 * Returns null if either string is not valid semver.
 */
function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major - pb.major;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch - pb.patch;
  }
  return 0;
}

/**
 * Strip a leading "v" prefix from a tag (e.g. "v1.2.3" → "1.2.3").
 */
function stripV(tag: string): string {
  return tag.startsWith("v") || tag.startsWith("V") ? tag.slice(1) : tag;
}

/**
 * Query the ghcr.io registry for available versions, filtered and sorted by channel.
 *
 * This is a pure HTTP operation that works from inside any container
 * (no Docker socket required). It authenticates anonymously via the
 * ghcr.io token exchange flow.
 *
 * @param params.channel - Update channel to filter tags by
 * @param params.imageName - Container image name (defaults to "openclaw/openclaw")
 * @param params.timeoutMs - HTTP timeout in milliseconds
 * @param params.fetchFn - Custom fetch implementation (for testing)
 * @returns Sorted tags and the latest version for the channel
 */
export async function queryRegistryVersions(params: {
  channel: UpdateChannel;
  imageName?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<DockerRegistryResult> {
  const imageName = params.imageName ?? DEFAULT_IMAGE_NAME;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Step 1: Obtain anonymous bearer token
  const tokenResult = await fetchGhcrToken({
    imageName,
    timeoutMs,
    fetchFn: params.fetchFn,
  });
  if (!tokenResult.token) {
    return {
      tags: [],
      latestVersion: null,
      latestTag: null,
      error: tokenResult.error,
    };
  }

  // Step 2: Fetch tag list
  const tagsResult = await fetchRegistryTags({
    imageName,
    token: tokenResult.token,
    timeoutMs,
    fetchFn: params.fetchFn,
  });
  if (tagsResult.error) {
    return {
      tags: [],
      latestVersion: null,
      latestTag: null,
      error: tagsResult.error,
    };
  }

  // Step 3: Filter to semver tags matching the channel
  const semverTags = tagsResult.tags
    .filter((tag) => isSemverTag(tag) && matchesChannel(tag, params.channel))
    .map((tag) => ({
      tag,
      version: stripV(tag),
    }))
    .toSorted((a, b) => {
      const cmp = compareSemver(a.version, b.version);
      return cmp != null ? -cmp : 0; // newest first
    });

  const latest = semverTags[0] ?? null;

  return {
    tags: semverTags,
    latestVersion: latest?.version ?? null,
    latestTag: latest?.tag ?? null,
  };
}
