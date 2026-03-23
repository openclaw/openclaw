import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAtLeast, parseSemver } from "./runtime-guard.js";

const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
export type ClawHubPackageChannel = "official" | "community" | "private";

export type ClawHubPackageListItem = {
  name: string;
  displayName: string;
  family: ClawHubPackageFamily;
  runtimeId?: string | null;
  channel: ClawHubPackageChannel;
  isOfficial: boolean;
  summary?: string | null;
  ownerHandle?: string | null;
  createdAt: number;
  updatedAt: number;
  latestVersion?: string | null;
  capabilityTags?: string[];
  executesCode?: boolean;
  verificationTier?: string | null;
};

export type ClawHubPackageDetail = {
  package:
    | (ClawHubPackageListItem & {
        tags?: Record<string, string>;
        compatibility?: {
          pluginApiRange?: string;
          builtWithOpenClawVersion?: string;
          minGatewayVersion?: string;
        } | null;
        capabilities?: {
          executesCode?: boolean;
          runtimeId?: string;
          capabilityTags?: string[];
          bundleFormat?: string;
          hostTargets?: string[];
          pluginKind?: string;
          channels?: string[];
          providers?: string[];
          hooks?: string[];
          bundledSkills?: string[];
        } | null;
        verification?: {
          tier?: string;
          scope?: string;
          summary?: string;
          sourceRepo?: string;
          sourceCommit?: string;
          hasProvenance?: boolean;
          scanStatus?: string;
        } | null;
      })
    | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type ClawHubPackageVersion = {
  package: {
    name: string;
    displayName: string;
    family: ClawHubPackageFamily;
  } | null;
  version: {
    version: string;
    createdAt: number;
    changelog: string;
    distTags?: string[];
    files?: unknown;
    compatibility?: ClawHubPackageDetail["package"] extends infer T
      ? T extends { compatibility?: infer C }
        ? C
        : never
      : never;
    capabilities?: ClawHubPackageDetail["package"] extends infer T
      ? T extends { capabilities?: infer C }
        ? C
        : never
      : never;
    verification?: ClawHubPackageDetail["package"] extends infer T
      ? T extends { verification?: infer C }
        ? C
        : never
      : never;
  } | null;
};

export type ClawHubPackageSearchResult = {
  score: number;
  package: ClawHubPackageListItem;
};

export type ClawHubSkillSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type ClawHubSkillListResponse = {
  items: Array<{
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    latestVersion?: {
      version: string;
      createdAt: number;
      changelog?: string;
    } | null;
    metadata?: {
      os?: string[] | null;
      systems?: string[] | null;
    } | null;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
};

export type ClawHubDownloadResult = {
  archivePath: string;
  integrity: string;
};

type FetchLike = typeof fetch;

type ComparableSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
};

type ClawHubRequestParams = {
  baseUrl?: string;
  path: string;
  token?: string;
  timeoutMs?: number;
  search?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
};

type ClawHubConfigLike = {
  token?: unknown;
  accessToken?: unknown;
  authToken?: unknown;
  apiToken?: unknown;
  auth?: ClawHubConfigLike | null;
  session?: ClawHubConfigLike | null;
  credentials?: ClawHubConfigLike | null;
  user?: ClawHubConfigLike | null;
};

export class ClawHubRequestError extends Error {
  readonly status: number;
  readonly requestPath: string;
  readonly responseBody: string;

  constructor(params: { path: string; status: number; body: string }) {
    super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "ClawHubRequestError";
    this.status = params.status;
    this.requestPath = params.path;
    this.responseBody = params.body;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  const envValue =
    process.env.OPENCLAW_CLAWHUB_URL?.trim() ||
    process.env.CLAWHUB_URL?.trim() ||
    DEFAULT_CLAWHUB_URL;
  const value = (baseUrl?.trim() || envValue).replace(/\/+$/, "");
  return value || DEFAULT_CLAWHUB_URL;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractTokenFromClawHubConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as ClawHubConfigLike;
  return (
    readNonEmptyString(record.accessToken) ??
    readNonEmptyString(record.authToken) ??
    readNonEmptyString(record.apiToken) ??
    readNonEmptyString(record.token) ??
    extractTokenFromClawHubConfig(record.auth) ??
    extractTokenFromClawHubConfig(record.session) ??
    extractTokenFromClawHubConfig(record.credentials) ??
    extractTokenFromClawHubConfig(record.user)
  );
}

function resolveClawHubConfigPaths(): string[] {
  const explicit =
    process.env.OPENCLAW_CLAWHUB_CONFIG_PATH?.trim() ||
    process.env.CLAWHUB_CONFIG_PATH?.trim() ||
    process.env.CLAWDHUB_CONFIG_PATH?.trim(); // legacy misspelling from older clawhub CLI builds; keep for back-compat
  if (explicit) {
    return [explicit];
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const configHome =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
  const xdgPath = path.join(configHome, "clawhub", "config.json");

  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "clawhub", "config.json"),
      xdgPath,
    ];
  }

  return [xdgPath];
}

export async function resolveClawHubAuthToken(): Promise<string | undefined> {
  const envToken =
    process.env.OPENCLAW_CLAWHUB_TOKEN?.trim() ||
    process.env.CLAWHUB_TOKEN?.trim() ||
    process.env.CLAWHUB_AUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  for (const configPath of resolveClawHubConfigPaths()) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const token = extractTokenFromClawHubConfig(JSON.parse(raw));
      if (token) {
        return token;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined;
}

function parseComparableSemver(version: string | null | undefined): ComparableSemver | null {
  if (!version) {
    return null;
  }
  const normalized = version.trim();
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    normalized,
  );
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prereleaseRaw] = match;
  if (!major || !minor || !patch) {
    return null;
  }
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prereleaseRaw ? prereleaseRaw.split(".").filter(Boolean) : null,
  };
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (!a?.length && !b?.length) {
    return 0;
  }
  if (!a?.length) {
    return 1;
  }
  if (!b?.length) {
    return -1;
  }

  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai == null && bi == null) {
      return 0;
    }
    if (ai == null) {
      return -1;
    }
    if (bi == null) {
      return 1;
    }
    const aNum = /^[0-9]+$/.test(ai) ? Number.parseInt(ai, 10) : null;
    const bNum = /^[0-9]+$/.test(bi) ? Number.parseInt(bi, 10) : null;
    if (aNum != null && bNum != null) {
      if (aNum !== bNum) {
        return aNum < bNum ? -1 : 1;
      }
      continue;
    }
    if (aNum != null) {
      return -1;
    }
    if (bNum != null) {
      return 1;
    }
    if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function compareSemver(left: string, right: string): number | null {
  const a = parseComparableSemver(left);
  const b = parseComparableSemver(right);
  if (!a || !b) {
    return null;
  }
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function upperBoundForCaret(version: string): string | null {
  const parsed = parseComparableSemver(version);
  if (!parsed) {
    return null;
  }
  if (parsed.major > 0) {
    return `${parsed.major + 1}.0.0`;
  }
  if (parsed.minor > 0) {
    return `0.${parsed.minor + 1}.0`;
  }
  return `0.0.${parsed.patch + 1}`;
}

function satisfiesComparator(version: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("^")) {
    const base = trimmed.slice(1).trim();
    const upperBound = upperBoundForCaret(base);
    const lowerCmp = compareSemver(version, base);
    const upperCmp = upperBound ? compareSemver(version, upperBound) : null;
    return lowerCmp != null && upperCmp != null && lowerCmp >= 0 && upperCmp < 0;
  }

  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const operator = match[1] ?? "=";
  const target = match[2]?.trim();
  if (!target) {
    return false;
  }
  const cmp = compareSemver(version, target);
  if (cmp == null) {
    return false;
  }
  switch (operator) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
    default:
      return cmp === 0;
  }
}

function satisfiesSemverRange(version: string, range: string): boolean {
  const tokens = range
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => satisfiesComparator(version, token));
}

function buildUrl(params: Pick<ClawHubRequestParams, "baseUrl" | "path" | "search">): URL {
  const url = new URL(params.path, `${normalizeBaseUrl(params.baseUrl)}/`);
  for (const [key, value] of Object.entries(params.search ?? {})) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url;
}

async function clawhubRequest(
  params: ClawHubRequestParams,
): Promise<{ response: Response; url: URL }> {
  const url = buildUrl(params);
  const token = params.token?.trim() || (await resolveClawHubAuthToken());
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          `ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`,
        ),
      ),
    params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    return { response, url };
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function fetchJson<T>(params: ClawHubRequestParams): Promise<T> {
  const { response, url } = await clawhubRequest(params);
  if (!response.ok) {
    throw new ClawHubRequestError({
      path: url.pathname,
      status: response.status,
      body: await readErrorBody(response),
    });
  }
  return (await response.json()) as T;
}

export function resolveClawHubBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function formatSha256Integrity(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("base64");
  return `sha256-${digest}`;
}

export function parseClawHubPluginSpec(raw: string): {
  name: string;
  version?: string;
  baseUrl?: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("clawhub:")) {
    return null;
  }
  const spec = trimmed.slice("clawhub:".length).trim();
  if (!spec) {
    return null;
  }
  const atIndex = spec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= spec.length - 1) {
    return { name: spec };
  }
  return {
    name: spec.slice(0, atIndex).trim(),
    version: spec.slice(atIndex + 1).trim() || undefined,
  };
}

export async function fetchClawHubPackageDetail(params: {
  name: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageDetail> {
  return await fetchJson<ClawHubPackageDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubPackageVersion(params: {
  name: string;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageVersion> {
  return await fetchJson<ClawHubPackageVersion>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(
      params.version,
    )}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function searchClawHubPackages(params: {
  query: string;
  family?: ClawHubPackageFamily;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubPackageSearchResult[]> {
  const result = await fetchJson<{ results: ClawHubPackageSearchResult[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/packages/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      family: params.family,
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return result.results ?? [];
}

export async function searchClawHubSkills(params: {
  query: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubSkillSearchResult[]> {
  const result = await fetchJson<{ results: ClawHubSkillSearchResult[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return result.results ?? [];
}

export async function fetchClawHubSkillDetail(params: {
  slug: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillDetail> {
  return await fetchJson<ClawHubSkillDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function listClawHubSkills(params: {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubSkillListResponse> {
  return await fetchJson<ClawHubSkillListResponse>({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
}

export async function downloadClawHubPackageArchive(params: {
  name: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  const search = params.version
    ? { version: params.version }
    : params.tag
      ? { tag: params.tag }
      : undefined;
  const { response, url } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/download`,
    search,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new ClawHubRequestError({
      path: url.pathname,
      status: response.status,
      body: await readErrorBody(response),
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-package-"));
  const archivePath = path.join(tmpDir, `${params.name}.zip`);
  await fs.writeFile(archivePath, bytes);
  return {
    archivePath,
    integrity: formatSha256Integrity(bytes),
  };
}

export async function downloadClawHubSkillArchive(params: {
  slug: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  const { response, url } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: "/api/v1/download",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      slug: params.slug,
      version: params.version,
      tag: params.version ? undefined : params.tag,
    },
  });
  if (!response.ok) {
    throw new ClawHubRequestError({
      path: url.pathname,
      status: response.status,
      body: await readErrorBody(response),
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-skill-"));
  const archivePath = path.join(tmpDir, `${params.slug}.zip`);
  await fs.writeFile(archivePath, bytes);
  return {
    archivePath,
    integrity: formatSha256Integrity(bytes),
  };
}

export function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null {
  return detail.package?.latestVersion ?? detail.package?.tags?.latest ?? null;
}

export function isClawHubFamilySkill(detail: ClawHubPackageDetail | ClawHubSkillDetail): boolean {
  if ("package" in detail) {
    return detail.package?.family === "skill";
  }
  return Boolean(detail.skill);
}

export function satisfiesPluginApiRange(
  pluginApiVersion: string,
  pluginApiRange?: string | null,
): boolean {
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesSemverRange(pluginApiVersion, pluginApiRange);
}

export function satisfiesGatewayMinimum(
  currentVersion: string,
  minGatewayVersion?: string | null,
): boolean {
  if (!minGatewayVersion) {
    return true;
  }
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minGatewayVersion);
  if (!current || !minimum) {
    return false;
  }
  return isAtLeast(current, minimum);
}
