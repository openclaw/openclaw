// Resolves and packages install sources for plugin installs.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  asNullableObjectRecord,
  asRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  gt as gtSemver,
  satisfies as satisfiesSemver,
  validRange as validSemverRange,
} from "semver";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import { resolveArchiveKind } from "./archive.js";
import { pathExists } from "./fs-safe.js";
import { cancelUnreadResponseBody } from "./http-body.js";
import { resolveInstallWorkTimeoutMs } from "./install-mode-options.js";
import { applyNpmFreshnessBypassEnv, type NpmProjectInstallEnvOptions } from "./npm-install-env.js";
import {
  isExactSemverVersion,
  parseRegistryNpmSpec,
  resolveNpmJsonEntries,
} from "./npm-registry-spec.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { fetchRegistryPackageDocument } from "./update-check-package-target.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";

export function formatNpmCommandFailureOutput(result: SpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (detail) {
    return detail;
  }
  // Timeouts normalize to exit code 124; retain the owner-recorded cause.
  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    return `termination ${result.termination} (no output from npm)`;
  }
  if (result.termination === "exit" && result.code !== null) {
    return `exit code ${result.code} (no output from npm)`;
  }
  if (result.signal) {
    return `signal ${result.signal} (no output from npm)`;
  }
  return `termination ${result.termination} (no output from npm)`;
}

/** Metadata npm reports when resolving a registry spec or packed archive. */
export type NpmSpecResolution = {
  name?: string;
  version?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
  packageOpenClaw?: Record<string, unknown>;
};

/** Flattened npm resolution fields stored on install results and diagnostics. */
type NpmResolutionFields = {
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
};

/** Converts npm resolution metadata into stable result field names. */
export function buildNpmResolutionFields(resolution?: NpmSpecResolution): NpmResolutionFields {
  return {
    resolvedName: resolution?.name,
    resolvedVersion: resolution?.version,
    resolvedSpec: resolution?.resolvedSpec,
    integrity: resolution?.integrity,
    shasum: resolution?.shasum,
    resolvedAt: resolution?.resolvedAt,
  };
}

/** Creates a script-free npm environment for metadata and pack commands. */
function createNpmMetadataEnv(
  scope: Pick<NpmProjectInstallEnvOptions, "npmConfigCwd"> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  applyNpmFreshnessBypassEnv(env, new Date(), scope);
  return env;
}

export async function loadNpmPackageVersions({
  packageName,
  timeoutMs,
  ...commandOptions
}: {
  packageName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  killProcessTree?: boolean;
}): Promise<string[] | null> {
  const versions = await runCommandWithTimeout(["npm", "view", packageName, "versions", "--json"], {
    ...commandOptions,
    timeoutMs: Math.max(timeoutMs ?? 0, 60_000),
    env: createNpmMetadataEnv(),
  });
  if (versions.code !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(versions.stdout.trim());
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
}

function resolveNpmSpecVersionSelector(spec: string): string | undefined {
  const separator = spec.lastIndexOf("@");
  return separator > 0 ? normalizeOptionalString(spec.slice(separator + 1)) : undefined;
}

function selectNpmViewMetadataEntry(value: unknown, spec: string): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const entries = value.filter(isRecord);
  if (entries.length === 1 && parseRegistryNpmSpec(spec)?.selectorKind === "tag") {
    // npm resolves literal tags before ranges; npm 12 wraps that single result.
    // Rechecking a semver-like tag against its spelling would reject a valid tag target.
    return entries[0];
  }
  const selector = resolveNpmSpecVersionSelector(spec);
  const range = selector ? validSemverRange(selector) : null;
  if (range) {
    // npm view output order tracks publication, not SemVer (a backport can be
    // published after a higher release), so pick the max satisfying version.
    let best: { entry: unknown; version: string } | undefined;
    for (const entry of entries) {
      const version = normalizeOptionalString(entry.version);
      if (!version || !satisfiesSemver(version, range)) {
        continue;
      }
      if (!best || gtSemver(version, best.version)) {
        best = { entry, version };
      }
    }
    // A recognized range with no satisfying entry must fail the metadata read
    // rather than silently resolve outside the requested constraint.
    return best?.entry;
  }
  return entries.at(-1);
}

function normalizeNpmViewMetadata(value: unknown, spec: string): NpmSpecResolution | null {
  // npm output varies by version, selector, and field projection. Multi-version
  // arrays follow publication order; selection above handles ranges and literal tags.
  const entry = selectNpmViewMetadataEntry(value, spec);
  if (!isRecord(entry)) {
    return null;
  }
  const name = normalizeOptionalString(entry.name);
  const version = normalizeOptionalString(entry.version);
  const resolvedSpec = name && version ? `${name}@${version}` : undefined;
  const dist = asRecord(entry.dist);
  return {
    name,
    version,
    resolvedSpec,
    integrity:
      normalizeOptionalString(entry["dist.integrity"]) ?? normalizeOptionalString(dist.integrity),
    shasum: normalizeOptionalString(entry["dist.shasum"]) ?? normalizeOptionalString(dist.shasum),
    ...(isRecord(entry.openclaw) ? { packageOpenClaw: entry.openclaw } : {}),
  };
}

/** Reads npm registry metadata for a package spec without running package scripts. */
type NpmMetadataFailureCategory = "metadata-env";

export async function resolveNpmSpecMetadata(params: {
  spec: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
      category?: NpmMetadataFailureCategory;
    }
> {
  const res = await runCommandWithTimeout(
    [
      "npm",
      "view",
      params.spec,
      "name",
      "version",
      "dist.integrity",
      "dist.shasum",
      "openclaw",
      "--json",
    ],
    {
      timeoutMs: Math.max(params.timeoutMs ?? 60_000, 60_000),
      signal: params.signal,
      killProcessTree: true,
      env: createNpmMetadataEnv(),
    },
  );
  if (res.code !== 0) {
    const raw = formatNpmCommandFailureOutput(res);
    if (/E404|is not in this registry/i.test(raw)) {
      return {
        ok: false,
        error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
      };
    }
    return { ok: false, error: `npm view failed: ${raw}`, category: "metadata-env" };
  }

  try {
    const parsed = JSON.parse(res.stdout.trim()) as unknown;
    const metadata = normalizeNpmViewMetadata(parsed, params.spec);
    if (!metadata?.name || !metadata.version) {
      const missingFields = [!metadata?.name ? "name" : null, !metadata?.version ? "version" : null]
        .filter((field): field is string => field !== null)
        .join(", ");
      return {
        ok: false,
        error: `npm view produced incomplete package metadata (missing: ${missingFields})`,
        category: "metadata-env",
      };
    }
    return { ok: true, metadata };
  } catch (err) {
    return {
      ok: false,
      error: `npm view produced invalid JSON: ${String(err)}`,
      category: "metadata-env",
    };
  }
}

export async function fetchRegistryPackageManifest(params: {
  registryUrl: string;
  packageName: string;
  version: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  { ok: true; metadata: NpmSpecResolution & { tarball: string } } | { ok: false; error: string }
> {
  try {
    const json = await fetchRegistryPackageDocument({
      ...params,
      target: params.version,
      label: "npm package manifest",
      operation: "npm-registry-package-manifest",
      bodyTimeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    });
    const metadata = normalizeNpmViewMetadata(json, `${params.packageName}@${params.version}`);
    const tarball = normalizeOptionalString(asRecord(asRecord(json).dist).tarball);
    if (!metadata?.name || !metadata.version || !tarball) {
      throw new Error("Registry returned incomplete package metadata (name, version, or tarball).");
    }
    return { ok: true, metadata: { ...metadata, tarball } };
  } catch (error) {
    return { ok: false, error: `Registry package manifest failed: ${String(error)}` };
  }
}

export async function downloadRegistryPackageArchive(params: {
  tarballUrl: string;
  registryUrl: string;
  integrity: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; archivePath: string } | { ok: false; error: string }> {
  const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    signal: params.signal,
    operation: "npm-registry-package-download",
  });
  let response: Response | undefined;
  let archivePath: string | undefined;
  try {
    const url = new URL(params.tarballUrl);
    if (url.origin !== new URL(params.registryUrl).origin) {
      throw new Error("Package tarball must share the registry origin.");
    }
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(params.integrity)) {
      throw new Error("Package archive requires supported sha512 integrity.");
    }
    // Reject redirects so a same-origin URL cannot send the download elsewhere.
    response = await fetch(url.toString(), { signal, redirect: "error" });
    if (!response.ok || !response.body) {
      throw new Error(`Package archive download failed: HTTP ${response.status}`);
    }
    refresh();
    const hash = createHash("sha512");
    archivePath = path.join(params.cwd, `${randomUUID()}.tgz`);
    await pipeline(
      response.body,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          refresh();
          yield chunk;
        }
      },
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal?.throwIfAborted();
    if (`sha512-${hash.digest("base64")}` !== params.integrity) {
      throw new Error("Package archive integrity mismatch.");
    }
    return { ok: true, archivePath };
  } catch (error) {
    if (archivePath) {
      await fs.rm(archivePath, { force: true });
    }
    return { ok: false, error: `Registry package archive failed: ${String(error)}` };
  } finally {
    await cancelUnreadResponseBody(response);
    cleanup();
  }
}

/** Captures expected and actual npm integrity values when an install source drifts. */
export type NpmIntegrityDrift = {
  expectedIntegrity: string;
  actualIntegrity: string;
};

/** Runs a callback in a private temp directory and removes it afterward. */
export async function withInstallWorkspace<T>(
  prefix: string,
  fn: (tmpDir: string) => Promise<T>,
  options?: { rootDir?: string },
): Promise<T> {
  const rootDir = options?.rootDir ?? resolvePreferredOpenClawTmpDir();
  return await withTempWorkspace({ rootDir, prefix }, async (tmp) => fn(tmp.dir));
}

/** Resolves and validates a user-supplied archive path before extraction. */
export async function resolveArchiveSourcePath(archivePath: string): Promise<
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const resolved = resolveUserPath(archivePath);
  if (!(await pathExists(resolved))) {
    return { ok: false, error: `archive not found: ${resolved}` };
  }

  if (!resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported archive: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

function parseResolvedSpecFromId(id: string): string | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at >= id.length - 1) {
    return undefined;
  }
  const name = id.slice(0, at).trim();
  const version = id.slice(at + 1).trim();
  if (!name || !version) {
    return undefined;
  }
  return `${name}@${version}`;
}

function normalizeNpmPackEntry(
  entry: unknown,
): { filename?: string; metadata: NpmSpecResolution } | null {
  const rec = asNullableObjectRecord(entry);
  if (!rec) {
    return null;
  }
  const name = normalizeOptionalString(rec.name);
  const version = normalizeOptionalString(rec.version);
  const id = normalizeOptionalString(rec.id);
  const resolvedSpec =
    (name && version ? `${name}@${version}` : undefined) ??
    (id ? parseResolvedSpecFromId(id) : undefined);

  return {
    filename: normalizeOptionalString(rec.filename),
    metadata: {
      name,
      version,
      resolvedSpec,
      integrity: normalizeOptionalString(rec.integrity),
      shasum: normalizeOptionalString(rec.shasum),
    },
  };
}

function parseNpmPackJsonOutput(
  raw: string,
): { filename?: string; metadata: NpmSpecResolution } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const arrayStart = trimmed.indexOf("[");
  if (arrayStart > 0) {
    candidates.push(trimmed.slice(arrayStart));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const entries = resolveNpmJsonEntries(parsed);
    let fallback: { filename?: string; metadata: NpmSpecResolution } | null = null;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const normalized = normalizeNpmPackEntry(entries[i]);
      if (!normalized) {
        continue;
      }
      if (!fallback) {
        fallback = normalized;
      }
      if (normalized.filename) {
        return normalized;
      }
    }
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

async function findPackedArchiveInDir(cwd: string): Promise<string | undefined> {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const archives = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
  // Callers give one spec a fresh workspace; empty npm stdout still leaves one owned artifact.
  return archives.length === 1 ? archives[0]?.name : undefined;
}

/** Packs an npm spec into a tarball in `cwd` and returns archive metadata. */
export async function packNpmSpecToArchive(params: {
  spec: string;
  timeoutMs: number;
  workTimeoutMs?: number | null;
  cwd: string;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      archivePath: string;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const res = await runCommandWithTimeout(
    [
      "npm",
      "pack",
      params.spec,
      "--ignore-scripts",
      "--json",
      "--dry-run=false",
      `--pack-destination=${params.cwd}`,
    ],
    {
      timeoutMs: resolveInstallWorkTimeoutMs(
        params.workTimeoutMs,
        Math.max(params.timeoutMs, 300_000),
      ),
      signal: params.signal,
      killProcessTree: true,
      cwd: params.cwd,
      env: createNpmMetadataEnv({ npmConfigCwd: params.cwd }),
    },
  );
  if (res.code !== 0) {
    const raw = formatNpmCommandFailureOutput(res);
    if (/E404|is not in this registry/i.test(raw)) {
      return {
        ok: false,
        error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
      };
    }
    return { ok: false, error: `npm pack failed: ${raw}` };
  }

  const parsedJson = parseNpmPackJsonOutput(res.stdout || "");

  const packed = parsedJson?.filename ?? (await findPackedArchiveInDir(params.cwd));
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  const archivePath = path.isAbsolute(packed) ? packed : path.join(params.cwd, packed);
  if (!(await pathExists(archivePath))) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  return {
    ok: true,
    archivePath,
    metadata: parsedJson?.metadata ?? {},
  };
}

/**
 * Reads package metadata from an existing npm archive using `npm pack --dry-run`.
 * The archive path is validated first so callers get path errors before npm errors.
 */
export async function resolveNpmPackArchiveMetadata(params: {
  archivePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      archivePath: string;
      tarballName: string;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;
  const archiveStat = await fs.stat(archivePath).catch(() => null);
  const archiveMetadataTimeoutMs =
    archiveStat && archiveStat.size > 100 * 1024 * 1024 ? 300_000 : 60_000;
  const res = await runCommandWithTimeout(
    ["npm", "pack", archivePath, "--ignore-scripts", "--dry-run", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs ?? archiveMetadataTimeoutMs, archiveMetadataTimeoutMs),
      signal: params.signal,
      killProcessTree: true,
      env: createNpmMetadataEnv(),
    },
  );
  if (res.code !== 0) {
    return {
      ok: false,
      error: `npm pack metadata read failed: ${formatNpmCommandFailureOutput(res)}`,
    };
  }

  const parsedJson = parseNpmPackJsonOutput(res.stdout || "");
  if (!parsedJson?.metadata.name || !parsedJson.metadata.version) {
    return { ok: false, error: "npm pack metadata read produced incomplete package metadata" };
  }
  return {
    ok: true,
    archivePath,
    tarballName: parsedJson.filename ?? path.basename(archivePath),
    metadata: parsedJson.metadata,
  };
}
