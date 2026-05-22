import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

type PluginManifestMetadataRecord = {
  pluginDir: string;
  manifest: Record<string, unknown>;
  origin?: string;
};

type CandidateDir = {
  pluginDir: string;
  rank: number;
  order: number;
  origin?: string;
};

const OPENCLAW_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
let manifestMetadataCache:
  | {
      key: string;
      records: PluginManifestMetadataRecord[];
    }
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveUserPath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/")) {
    const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const override = normalizeTrimmedString(env.OPENCLAW_STATE_DIR);
  if (override) {
    return resolveUserPath(override, env);
  }
  const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(home, ".openclaw");
}

function areBundledPluginsDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = normalizeTrimmedString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS)?.toLowerCase();
  return value === "1" || value === "true";
}

function hasManifestDir(root: string | undefined): root is string {
  return Boolean(root && fs.existsSync(root));
}

function resolveBundledPluginRoot(env: NodeJS.ProcessEnv): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return undefined;
  }

  const override = normalizeTrimmedString(env.OPENCLAW_BUNDLED_PLUGINS_DIR);
  if (override) {
    return resolveUserPath(override, env);
  }

  const sourceRoot = path.join(OPENCLAW_PACKAGE_ROOT, "extensions");
  const runtimeRoot = path.join(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions");
  const distRoot = path.join(OPENCLAW_PACKAGE_ROOT, "dist", "extensions");
  return [sourceRoot, runtimeRoot, distRoot].find(hasManifestDir);
}

function listChildPluginDirs(
  root: string | undefined,
  rank: number,
  startOrder: number,
  origin: string,
): CandidateDir[] {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const dirs: CandidateDir[] = [];
  let order = startOrder;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push({ pluginDir: path.join(root, entry.name), rank, order: order++, origin });
      }
    }
  } catch {
    return [];
  }
  return dirs;
}

// mtime+size-keyed cache for parsed JSON objects. Entries are invalidated whenever
// the underlying file's mtime or size changes; otherwise the parsed object is reused
// across calls.
//
// Rationale: `listOpenClawPluginManifestMetadata` and its peers are invoked many
// times per second on busy gateways (per-tool-call, per-model-request, per snapshot
// resolution from `provider-attribution`, `model-auth-markers`, and other
// `getCurrentPluginMetadataSnapshot` consumers). Each call previously walked every
// candidate plugin directory and re-read every `openclaw.plugin.json` from disk via
// `fs.readFileSync` even when no manifest had changed. Empirical strace from a long-
// running gateway (`elliott` seat, PID 1103840) recorded ~5,699 `O_RDONLY` opens of
// `openclaw.plugin.json` files in a 60-second window (~95/s) on an idle gateway,
// driving the high-cadence FSReqPromise allocation that compounds with retention
// elsewhere to produce the observed RSS growth (see karmaterminal/openclaw#740).
//
// The cache keys on (mtimeNs, size) which detect both content changes and
// touch-based replacements. Eviction is bounded by entry-count so that this scales
// to repos with thousands of plugin manifests without unbounded memory.
type ParsedJsonCacheEntry = {
  mtimeNs: bigint;
  size: bigint;
  parsed: Record<string, unknown> | undefined;
};

const PARSED_JSON_CACHE_MAX_ENTRIES = 10_000;
const parsedJsonCache = new Map<string, ParsedJsonCacheEntry>();

function cacheParsedJson(
  filePath: string,
  mtimeNs: bigint,
  size: bigint,
  parsed: Record<string, unknown> | undefined,
): void {
  if (parsedJsonCache.size >= PARSED_JSON_CACHE_MAX_ENTRIES) {
    // Map iteration preserves insertion order; drop the oldest entry to keep the
    // cache bounded. This is an O(1) eviction without a separate LRU list.
    const oldestKey = parsedJsonCache.keys().next().value;
    if (oldestKey !== undefined) {
      parsedJsonCache.delete(oldestKey);
    }
  }
  parsedJsonCache.set(filePath, { mtimeNs, size, parsed });
}

/**
 * Internal helper: clears the parsed-JSON cache. Exposed for tests; not part of
 * the public module API.
 */
export function clearParsedJsonCacheForTesting(): void {
  parsedJsonCache.clear();
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  let stat: ReturnType<typeof fs.statSync> | undefined;
  try {
    stat = fs.statSync(filePath, { bigint: true });
  } catch {
    // File does not exist or is unreadable. Cache the negative result keyed on
    // "missing" sentinel so repeat lookups don't keep retrying the stat syscall
    // in tight loops. Use unique sentinel values so we can still detect the file
    // re-appearing via subsequent successful stats invalidating the entry.
    const cached = parsedJsonCache.get(filePath);
    if (cached && cached.mtimeNs === -1n && cached.size === -1n) {
      return cached.parsed;
    }
    cacheParsedJson(filePath, -1n, -1n, undefined);
    return undefined;
  }
  const mtimeNs = stat.mtimeNs;
  const size = stat.size;
  const cached = parsedJsonCache.get(filePath);
  if (cached && cached.mtimeNs === mtimeNs && cached.size === size) {
    // Hit: same mtime + same size means content unchanged since last parse.
    // Refresh insertion-order position for LRU semantics.
    parsedJsonCache.delete(filePath);
    parsedJsonCache.set(filePath, cached);
    return cached.parsed;
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = parseJsonWithJson5Fallback(fs.readFileSync(filePath, "utf8"));
    parsed = isRecord(raw) ? raw : undefined;
  } catch {
    parsed = undefined;
  }
  cacheParsedJson(filePath, mtimeNs, size, parsed);
  return parsed;
}

function readManifestObject(pluginDir: string): Record<string, unknown> | undefined {
  return readJsonObject(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
}

function manifestFileFingerprint(pluginDir: string): string {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);
  try {
    const stat = fs.statSync(manifestPath);
    return `${manifestPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${manifestPath}:missing`;
  }
}

function listPersistedIndexPluginDirs(env: NodeJS.ProcessEnv, startOrder: number): CandidateDir[] {
  const index = readJsonObject(path.join(resolveStateDir(env), "plugins", "installs.json"));
  if (!index || !Array.isArray(index.plugins)) {
    return [];
  }

  const dirs: CandidateDir[] = [];
  let order = startOrder;
  for (const rawPlugin of index.plugins) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const rootDir = normalizeTrimmedString(rawPlugin.rootDir);
    if (!rootDir) {
      continue;
    }
    dirs.push({
      pluginDir: resolveUserPath(rootDir, env),
      rank: rawPlugin.origin === "bundled" ? 3 : 1,
      order: order++,
      origin: normalizeTrimmedString(rawPlugin.origin),
    });
  }
  return dirs;
}

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function uniqueCandidateDirs(candidates: CandidateDir[]): CandidateDir[] {
  const byPath = new Map<string, CandidateDir>();
  for (const candidate of candidates) {
    const key = resolveComparablePath(candidate.pluginDir);
    const existing = byPath.get(key);
    if (!existing || candidate.rank < existing.rank || candidate.order < existing.order) {
      byPath.set(key, candidate);
    }
  }
  return [...byPath.values()].toSorted(
    (left, right) => left.rank - right.rank || left.order - right.order,
  );
}

export function listOpenClawPluginManifestMetadata(
  env: NodeJS.ProcessEnv = process.env,
): PluginManifestMetadataRecord[] {
  const candidates: CandidateDir[] = [];
  let order = 0;
  candidates.push(...listPersistedIndexPluginDirs(env, order));
  order = candidates.length;
  candidates.push(...listChildPluginDirs(resolveBundledPluginRoot(env), 2, order, "bundled"));
  order = candidates.length;
  candidates.push(
    ...listChildPluginDirs(path.join(resolveStateDir(env), "extensions"), 4, order, "global"),
  );

  const uniqueCandidates = uniqueCandidateDirs(candidates);
  const cacheKey = JSON.stringify(
    uniqueCandidates.map((candidate) => [
      candidate.pluginDir,
      candidate.rank,
      candidate.order,
      candidate.origin ?? "",
      manifestFileFingerprint(candidate.pluginDir),
    ]),
  );
  if (manifestMetadataCache?.key === cacheKey) {
    return manifestMetadataCache.records.slice();
  }

  const byManifestId = new Map<string, CandidateDir>();
  const records: PluginManifestMetadataRecord[] = [];
  for (const candidate of uniqueCandidates) {
    const manifest = readManifestObject(candidate.pluginDir);
    if (!manifest) {
      continue;
    }
    const manifestId = normalizeTrimmedString(manifest.id);
    if (manifestId) {
      const existing = byManifestId.get(manifestId);
      if (existing && existing.rank <= candidate.rank) {
        continue;
      }
      byManifestId.set(manifestId, candidate);
    }
    records.push({ pluginDir: candidate.pluginDir, manifest, origin: candidate.origin });
  }
  manifestMetadataCache = { key: cacheKey, records };
  return records;
}
