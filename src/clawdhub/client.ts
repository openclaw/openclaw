/**
 * ClawdHub API client for the public skills registry.
 * Handles search, details, install, and update operations.
 */

const DEFAULT_REGISTRY_URL = "https://clawdhub.com";

export type ClawdHubSearchResult = {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  author?: string;
  version: string;
  downloads: number;
  stars: number;
  updatedAt: string;
  tags: string[];
};

export type ClawdHubSearchResponse = {
  results: ClawdHubSearchResult[];
  total: number;
  query: string;
};

export type ClawdHubSkillVersion = {
  version: string;
  changelog?: string;
  publishedAt: string;
  tags: string[];
  downloads: number;
};

export type ClawdHubSkillDetails = {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  readme?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  currentVersion: string;
  versions: ClawdHubSkillVersion[];
  downloads: number;
  stars: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type ClawdHubInstalledSkill = {
  slug: string;
  version: string;
  installedAt: string;
  path: string;
};

export type ClawdHubLockFile = {
  version: number;
  skills: Record<string, ClawdHubInstalledSkill>;
};

export type ClawdHubInstallResult = {
  ok: boolean;
  slug: string;
  version: string;
  path: string;
  message?: string;
};

export type ClawdHubUpdateCheck = {
  slug: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
};

export type ClawdHubClientOptions = {
  registryUrl?: string;
  timeout?: number;
};

function getRegistryUrl(): string {
  return process.env.CLAWDHUB_REGISTRY || DEFAULT_REGISTRY_URL;
}

async function fetchJson<T>(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "clawdbot-gateway",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Search for skills in ClawdHub using vector search.
 */
export async function searchSkills(
  query: string,
  options: ClawdHubClientOptions = {},
): Promise<ClawdHubSearchResponse> {
  const registryUrl = options.registryUrl || getRegistryUrl();
  const params = new URLSearchParams({ q: query });
  const url = `${registryUrl}/api/skills/search?${params}`;

  return fetchJson<ClawdHubSearchResponse>(url, {}, options.timeout);
}

/**
 * Get detailed information about a skill including all versions.
 */
export async function getSkillDetails(
  slug: string,
  options: ClawdHubClientOptions = {},
): Promise<ClawdHubSkillDetails> {
  const registryUrl = options.registryUrl || getRegistryUrl();
  const url = `${registryUrl}/api/skills/${encodeURIComponent(slug)}`;

  return fetchJson<ClawdHubSkillDetails>(url, {}, options.timeout);
}

/**
 * Download a skill zip from ClawdHub.
 */
export async function downloadSkillZip(
  slug: string,
  version: string,
  options: ClawdHubClientOptions = {},
): Promise<ArrayBuffer> {
  const registryUrl = options.registryUrl || getRegistryUrl();
  const url = `${registryUrl}/api/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`;

  const controller = new AbortController();
  const timeoutMs = options.timeout || 60000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "clawdbot-gateway",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.arrayBuffer();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check for updates across multiple installed skills.
 */
export async function checkUpdates(
  installed: ClawdHubInstalledSkill[],
  options: ClawdHubClientOptions = {},
): Promise<ClawdHubUpdateCheck[]> {
  const results: ClawdHubUpdateCheck[] = [];

  for (const skill of installed) {
    try {
      const details = await getSkillDetails(skill.slug, options);
      results.push({
        slug: skill.slug,
        currentVersion: skill.version,
        latestVersion: details.currentVersion,
        hasUpdate: details.currentVersion !== skill.version,
      });
    } catch {
      // Skip skills that can't be fetched
      results.push({
        slug: skill.slug,
        currentVersion: skill.version,
        latestVersion: skill.version,
        hasUpdate: false,
      });
    }
  }

  return results;
}
