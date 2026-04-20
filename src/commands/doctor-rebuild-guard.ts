import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { note } from "../terminal/note.js";

export type RebuildGuardVerdict =
  | "pristine"
  | "rebuild"
  | "unreleased"
  | "inconclusive"
  | "corrupt";

export interface RebuildGuardResult {
  verdict: RebuildGuardVerdict;
  version: string;
  commit?: string;
  builtAt?: string;
  npmPublishedAt?: string;
  skewMinutes?: number;
  reason: string;
}

export interface RebuildGuardOptions {
  packageRoot: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  offline?: boolean;
  cacheFile?: string;
  cacheTtlMs?: number;
}

type LocalMetadata =
  | {
      ok: true;
      version: string;
      commit?: string;
      builtAt: string;
      builtAtMs: number;
    }
  | {
      ok: false;
      version: string;
      reason: string;
    };

const NPM_REGISTRY_URL = "https://registry.npmjs.org/openclaw";
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REBUILD_SKEW_THRESHOLD_MS = 60 * 60 * 1000;

function defaultCacheFile(): string {
  return path.join(os.homedir(), ".openclaw", "rebuild-guard-cache.json");
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function parseIsoMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readLocalMetadata(packageRoot: string): Promise<LocalMetadata> {
  const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const buildInfo = await readJsonFile(buildInfoPath);
  if (!buildInfo) {
    return { ok: false, version: "", reason: "build-info-missing" };
  }
  const packageJson = await readJsonFile(packageJsonPath);
  if (!packageJson) {
    return { ok: false, version: "", reason: "package-json-missing" };
  }

  const version = getStringProperty(buildInfo, "version");
  const builtAt = getStringProperty(buildInfo, "builtAt");
  const packageVersion = getStringProperty(packageJson, "version");
  if (!version || !builtAt || !packageVersion) {
    return { ok: false, version: version ?? packageVersion ?? "", reason: "metadata-malformed" };
  }

  const builtAtMs = parseIsoMs(builtAt);
  if (builtAtMs === null) {
    return { ok: false, version, reason: "builtAt-unparseable" };
  }

  return {
    ok: true,
    version,
    commit: getStringProperty(buildInfo, "commit"),
    builtAt,
    builtAtMs,
  };
}

function readRegistryTimeMap(registryJson: unknown): Record<string, string> | null {
  if (!registryJson || typeof registryJson !== "object") {
    return null;
  }
  const time = (registryJson as Record<string, unknown>).time;
  if (!time || typeof time !== "object" || Array.isArray(time)) {
    return null;
  }
  const entries = Object.entries(time).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return Object.fromEntries(entries);
}

async function loadRegistryFile(filePath: string): Promise<Record<string, string> | null> {
  const json = await readJsonFile(filePath);
  return readRegistryTimeMap(json);
}

async function loadFreshCache(params: {
  cacheFile: string;
  cacheTtlMs: number;
  now: () => Date;
}): Promise<Record<string, string> | null> {
  try {
    const stat = await fs.stat(params.cacheFile);
    if (params.now().getTime() - stat.mtimeMs > params.cacheTtlMs) {
      return null;
    }
  } catch {
    return null;
  }
  return loadRegistryFile(params.cacheFile);
}

async function writeCache(cacheFile: string, payload: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = path.join(
      path.dirname(cacheFile),
      `.${path.basename(cacheFile)}.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.writeFile(tmp, `${payload}\n`, "utf8");
    await fs.rename(tmp, cacheFile);
  } catch {
    // Cache writes are best-effort; the doctor check must never block on them.
  }
}

async function fetchRegistry(params: {
  fetchFn: typeof fetch;
  cacheFile: string;
}): Promise<Record<string, string> | null> {
  try {
    const response = await params.fetchFn(NPM_REGISTRY_URL);
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const registry = readRegistryTimeMap(JSON.parse(text) as unknown);
    if (!registry) {
      return null;
    }
    await writeCache(params.cacheFile, text);
    return registry;
  } catch {
    return null;
  }
}

async function loadRegistry(params: {
  fetchFn: typeof fetch;
  now: () => Date;
  offline: boolean;
  cacheFile: string;
  cacheTtlMs: number;
}): Promise<Record<string, string> | null> {
  const registryFile = process.env.OPENCLAW_NPM_REGISTRY_FILE;
  if (registryFile) {
    const registry = await loadRegistryFile(registryFile);
    if (registry) {
      return registry;
    }
  }

  if (!params.offline) {
    const freshCache = await loadFreshCache({
      cacheFile: params.cacheFile,
      cacheTtlMs: params.cacheTtlMs,
      now: params.now,
    });
    if (freshCache) {
      return freshCache;
    }

    const fetched = await fetchRegistry({
      fetchFn: params.fetchFn,
      cacheFile: params.cacheFile,
    });
    if (fetched) {
      return fetched;
    }
  }

  return loadRegistryFile(params.cacheFile);
}

export async function evaluateRebuildGuard(opts: RebuildGuardOptions): Promise<RebuildGuardResult> {
  const local = await readLocalMetadata(opts.packageRoot);
  if (!local.ok) {
    return {
      verdict: "corrupt",
      version: local.version,
      reason: local.reason,
    };
  }

  const baseResult = {
    version: local.version,
    ...(local.commit ? { commit: local.commit } : {}),
    builtAt: local.builtAt,
  };
  const registry = await loadRegistry({
    fetchFn: opts.fetchFn ?? fetch,
    now: opts.now ?? (() => new Date()),
    offline: opts.offline ?? false,
    cacheFile: opts.cacheFile ?? defaultCacheFile(),
    cacheTtlMs: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  });

  if (!registry) {
    return {
      verdict: "inconclusive",
      ...baseResult,
      reason: "registry-unavailable",
    };
  }

  const npmPublishedAt = registry[local.version];
  if (!npmPublishedAt) {
    return {
      verdict: "unreleased",
      ...baseResult,
      reason: "version-unreleased",
    };
  }

  const npmPublishedAtMs = parseIsoMs(npmPublishedAt);
  if (npmPublishedAtMs === null) {
    return {
      verdict: "inconclusive",
      ...baseResult,
      npmPublishedAt,
      reason: "npm-time-unparseable",
    };
  }

  const skewMs = local.builtAtMs - npmPublishedAtMs;
  const skewMinutes = skewMs / 60_000;
  if (skewMs >= REBUILD_SKEW_THRESHOLD_MS) {
    return {
      verdict: "rebuild",
      ...baseResult,
      npmPublishedAt,
      skewMinutes,
      reason: "builtAt-after-publish",
    };
  }
  if (skewMs <= -REBUILD_SKEW_THRESHOLD_MS) {
    return {
      verdict: "inconclusive",
      ...baseResult,
      npmPublishedAt,
      skewMinutes,
      reason: "builtAt-before-publish",
    };
  }
  return {
    verdict: "pristine",
    ...baseResult,
    npmPublishedAt,
    skewMinutes,
    reason: "within-skew-window",
  };
}

function formatRebuildGuardNote(result: RebuildGuardResult, packageRoot: string): string {
  const lines = [
    "Local OpenClaw install differs from the pristine npm release.",
    `- Install: ${packageRoot}`,
    `- Version: ${result.version || "unknown"}`,
  ];
  if (result.commit) {
    lines.push(`- Commit: ${result.commit}`);
  }
  if (result.builtAt) {
    lines.push(`- builtAt: ${result.builtAt}`);
  }
  if (result.npmPublishedAt) {
    lines.push(`- npm publish: ${result.npmPublishedAt}`);
  }
  if (typeof result.skewMinutes === "number") {
    lines.push(`- Skew: ${Math.round(result.skewMinutes)} minutes ahead of npm`);
  }
  lines.push(
    `- Reason: ${result.reason}`,
    "Confirm every local patch has a matching upstream PR before running `openclaw update`.",
  );
  return lines.join("\n");
}

export async function noteRebuildGuardHealth(
  packageRoot: string | null,
  opts: Omit<RebuildGuardOptions, "packageRoot"> = {},
): Promise<void> {
  // When doctor cannot resolve a package root (ad-hoc CLI invocations, lightly
  // installed contexts), there is nothing to compare against the npm registry.
  // Mirror the same silent behavior as the other `note*` install helpers.
  if (!packageRoot) {
    return;
  }
  const result = await evaluateRebuildGuard({ ...opts, packageRoot });
  if (result.verdict === "pristine" || result.verdict === "inconclusive") {
    return;
  }

  if (result.verdict === "corrupt") {
    note(
      [
        "OpenClaw install metadata is missing or malformed.",
        `- Install: ${packageRoot}`,
        `- Reason: ${result.reason}`,
      ].join("\n"),
      "Install",
    );
    return;
  }

  note(formatRebuildGuardNote(result, packageRoot), "Install");
}
