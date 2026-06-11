import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { isGatewayDistEntrypointPath } from "./gateway-entrypoint.js";

export const GATEWAY_RUNTIME_SNAPSHOT_ROOT_ENV_KEY = "OPENCLAW_RUNTIME_SNAPSHOT_ROOT";
export const GATEWAY_RUNTIME_SNAPSHOT_PLUGINS_ENV_KEY = "OPENCLAW_BUNDLED_PLUGINS_DIR";

const SNAPSHOT_RELATIVE_DIR = path.join(".artifacts", "openclaw-gateway-runtime");
const SNAPSHOT_RELEASES_DIR = "releases";
const SNAPSHOT_LATEST_FILE = "latest.json";
const DEFAULT_SNAPSHOT_KEEP_COUNT = 8;

export type GatewayRuntimeSnapshotServiceCommand = {
  programArguments: string[];
  environment: Record<string, string>;
  snapshotRoot?: string;
};

export type GatewayRuntimeSnapshotReleaseStatus = {
  releaseId: string;
  root: string;
  createdAt?: string;
  createdAtMs: number;
  sizeBytes?: number;
  latest: boolean;
  protected: boolean;
  usable: boolean;
};

export type GatewayRuntimeSnapshotStatus = {
  snapshotDir: string;
  latestPath: string;
  latestReleaseId: string | null;
  latestRoot: string | null;
  protectedRoots: string[];
  releaseCount: number;
  totalBytes: number;
  releases: GatewayRuntimeSnapshotReleaseStatus[];
};

export type GatewayRuntimeSnapshotPruneResult = {
  keepCount?: number;
  pruned: Array<{ releaseId: string; root: string }>;
  retained: Array<{ releaseId: string; root: string; protected: boolean }>;
  skipped?: "disabled";
};

export type GatewayRuntimeSnapshotRollbackResult = {
  rolledBack: true;
  releaseId: string;
  releaseRoot: string;
  latestPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function readLatestSnapshot(packageRoot: string): string | null {
  const latestPath = path.join(packageRoot, SNAPSHOT_RELATIVE_DIR, SNAPSHOT_LATEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.root !== "string" || !parsed.root.trim()) {
    return null;
  }
  return path.resolve(parsed.root);
}

function readJsonFileIfPresent(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function safeRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function isTrustedSnapshotRoot(packageRoot: string, snapshotRoot: string): boolean {
  const releasesDir = path.join(packageRoot, SNAPSHOT_RELATIVE_DIR, SNAPSHOT_RELEASES_DIR);
  const realPackageRoot = safeRealpath(packageRoot);
  const realReleasesDir = safeRealpath(releasesDir);
  const realSnapshotRoot = safeRealpath(snapshotRoot);
  return Boolean(
    realPackageRoot &&
    realReleasesDir &&
    realSnapshotRoot &&
    isPathInside(realPackageRoot, realSnapshotRoot) &&
    isPathInside(realReleasesDir, realSnapshotRoot),
  );
}

function isUsableSnapshotRoot(snapshotRoot: string): boolean {
  return (
    fs.existsSync(path.join(snapshotRoot, "dist", "index.js")) &&
    fs.existsSync(path.join(snapshotRoot, "dist", "entry.js")) &&
    fs.existsSync(path.join(snapshotRoot, "dist", "control-ui", "index.html")) &&
    fs.existsSync(path.join(snapshotRoot, "dist-runtime", "extensions"))
  );
}

function resolveSnapshotPaths(rootDir: string) {
  const snapshotDir = path.join(rootDir, SNAPSHOT_RELATIVE_DIR);
  const releasesDir = path.join(snapshotDir, SNAPSHOT_RELEASES_DIR);
  return {
    snapshotDir,
    releasesDir,
    latestPath: path.join(snapshotDir, SNAPSHOT_LATEST_FILE),
  };
}

function parseKeepCount(value: string | number | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_SNAPSHOT_KEEP_COUNT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_SNAPSHOT_KEEP_COUNT;
  }
  return Math.max(2, parsed);
}

function normalizeReleaseId(releaseId: string): string {
  const normalized = releaseId.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Invalid Gateway runtime snapshot release id: ${releaseId}`);
  }
  return normalized;
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function directorySizeBytes(dirPath: string): number {
  const stat = safeStat(dirPath);
  if (!stat) {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.reduce(
    (total, entry) => total + directorySizeBytes(path.join(dirPath, entry.name)),
    0,
  );
}

function releaseRootFromPath(candidatePath: string, releasesDir: string): string | null {
  const relativePath = path.relative(releasesDir, path.resolve(candidatePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  const releaseId = relativePath.split(path.sep)[0];
  return releaseId ? path.join(releasesDir, releaseId) : null;
}

function collectReleaseRootsFromText(text: string, releasesDir: string): Set<string> {
  const roots = new Set<string>();
  let start = text.indexOf(releasesDir);
  while (start >= 0) {
    let end = start;
    while (end < text.length && !/[\s<>"']/u.test(text[end] ?? "")) {
      end += 1;
    }
    const root = releaseRootFromPath(text.slice(start, end), releasesDir);
    if (root) {
      roots.add(path.resolve(root));
    }
    start = text.indexOf(releasesDir, end);
  }
  return roots;
}

function collectLaunchAgentProtectedRoots(rootDir: string, env: NodeJS.ProcessEnv): Set<string> {
  const home = env.HOME;
  if (!home) {
    return new Set();
  }
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const { releasesDir } = resolveSnapshotPaths(rootDir);
  const protectedRoots = new Set<string>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(launchAgentsDir, { withFileTypes: true });
  } catch {
    return protectedRoots;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^ai\.openclaw(?:\.|$)/u.test(entry.name)) {
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(launchAgentsDir, entry.name), "utf8");
    } catch {
      continue;
    }
    for (const root of collectReleaseRootsFromText(text, releasesDir)) {
      protectedRoots.add(root);
    }
  }
  return protectedRoots;
}

function collectProtectedReleaseRoots(params: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  protectedRoots?: readonly string[];
}): Set<string> {
  const protectedRoots = new Set<string>();
  for (const root of params.protectedRoots ?? []) {
    if (root.trim()) {
      protectedRoots.add(path.resolve(root));
    }
  }
  const latest = readJsonFileIfPresent(resolveSnapshotPaths(params.rootDir).latestPath);
  if (isRecord(latest) && typeof latest.root === "string" && latest.root.trim()) {
    protectedRoots.add(path.resolve(latest.root));
  }
  for (const root of collectLaunchAgentProtectedRoots(params.rootDir, params.env ?? process.env)) {
    protectedRoots.add(root);
  }
  return protectedRoots;
}

function listSnapshotReleases(params: { rootDir: string; includeSize?: boolean }): Array<{
  releaseId: string;
  root: string;
  createdAt?: string;
  createdAtMs: number;
  sizeBytes?: number;
}> {
  const { releasesDir } = resolveSnapshotPaths(params.rootDir);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(releasesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const releaseRoot = path.join(releasesDir, entry.name);
      const snapshot = readJsonFileIfPresent(path.join(releaseRoot, "snapshot.json"));
      const stat = safeStat(releaseRoot);
      const createdAt =
        isRecord(snapshot) && typeof snapshot.createdAt === "string"
          ? snapshot.createdAt
          : undefined;
      const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
      return {
        releaseId: entry.name,
        root: releaseRoot,
        createdAt,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : (stat?.mtimeMs ?? 0),
        sizeBytes: params.includeSize ? directorySizeBytes(releaseRoot) : undefined,
      };
    })
    .toSorted((left, right) => {
      const byCreatedAt = right.createdAtMs - left.createdAtMs;
      return byCreatedAt !== 0 ? byCreatedAt : right.releaseId.localeCompare(left.releaseId);
    });
}

function resolveSourceCheckoutRootFromSnapshotPath(inputPath: string): string | null {
  const parts = path.resolve(inputPath).split(path.sep);
  const markerIndex = parts.findIndex(
    (part, index) => part === ".artifacts" && parts[index + 1] === "openclaw-gateway-runtime",
  );
  if (markerIndex <= 0) {
    return null;
  }
  const candidate = parts.slice(0, markerIndex).join(path.sep) || path.sep;
  return isSourceCheckoutRoot(candidate) ? candidate : null;
}

function findGatewayEntrypointArgIndex(programArguments: readonly string[]): number {
  return programArguments.findIndex((arg) => isGatewayDistEntrypointPath(path.resolve(arg)));
}

function resolvePackageRootForEntrypoint(params: {
  entrypoint: string;
  cwd?: string;
}): string | null {
  const sourceCheckoutRoot = resolveSourceCheckoutRootFromSnapshotPath(params.entrypoint);
  if (sourceCheckoutRoot) {
    return sourceCheckoutRoot;
  }

  return resolveOpenClawPackageRootSync({
    argv1: params.entrypoint,
    cwd: params.cwd ?? process.cwd(),
  });
}

export function resolveGatewayRuntimeSnapshotServiceCommand(params: {
  programArguments: readonly string[];
  environment?: Record<string, string | undefined>;
  cwd?: string;
}): GatewayRuntimeSnapshotServiceCommand {
  const programArguments = [...params.programArguments];
  const entrypointIndex = findGatewayEntrypointArgIndex(programArguments);
  if (entrypointIndex < 0) {
    return { programArguments, environment: {} };
  }

  const entrypoint = path.resolve(programArguments[entrypointIndex] ?? "");
  const packageRoot = resolvePackageRootForEntrypoint({ entrypoint, cwd: params.cwd });
  if (!packageRoot || !isSourceCheckoutRoot(packageRoot)) {
    return { programArguments, environment: {} };
  }

  const snapshotRoot = readLatestSnapshot(packageRoot);
  if (
    !snapshotRoot ||
    !isTrustedSnapshotRoot(packageRoot, snapshotRoot) ||
    !isUsableSnapshotRoot(snapshotRoot)
  ) {
    return { programArguments, environment: {} };
  }

  const snapshotEntrypoint = path.join(snapshotRoot, "dist", "index.js");
  programArguments[entrypointIndex] = snapshotEntrypoint;
  return {
    programArguments,
    snapshotRoot,
    environment: {
      [GATEWAY_RUNTIME_SNAPSHOT_ROOT_ENV_KEY]: snapshotRoot,
      [GATEWAY_RUNTIME_SNAPSHOT_PLUGINS_ENV_KEY]: path.join(
        snapshotRoot,
        "dist-runtime",
        "extensions",
      ),
    },
  };
}

export function getGatewayRuntimeSnapshotStatus(
  params: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    includeSize?: boolean;
    protectedRoots?: readonly string[];
  } = {},
): GatewayRuntimeSnapshotStatus {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const { snapshotDir, latestPath } = resolveSnapshotPaths(rootDir);
  const latest = readJsonFileIfPresent(latestPath);
  const latestRoot =
    isRecord(latest) && typeof latest.root === "string" && latest.root.trim()
      ? path.resolve(latest.root)
      : null;
  const protectedRoots = collectProtectedReleaseRoots({
    rootDir,
    env: params.env,
    protectedRoots: params.protectedRoots,
  });
  const releases = listSnapshotReleases({
    rootDir,
    includeSize: params.includeSize,
  }).map((release) => {
    const resolvedRoot = path.resolve(release.root);
    return Object.assign({}, release, {
      latest: latestRoot === resolvedRoot,
      protected: protectedRoots.has(resolvedRoot),
      usable: isUsableSnapshotRoot(release.root),
    });
  });
  return {
    snapshotDir,
    latestPath,
    latestReleaseId: releases.find((release) => release.latest)?.releaseId ?? null,
    latestRoot,
    protectedRoots: [...protectedRoots].toSorted((left, right) => left.localeCompare(right)),
    releaseCount: releases.length,
    totalBytes: releases.reduce((total, release) => total + (release.sizeBytes ?? 0), 0),
    releases,
  };
}

export function pruneGatewayRuntimeSnapshots(
  params: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    keepCount?: string | number;
    protectedRoots?: readonly string[];
  } = {},
): GatewayRuntimeSnapshotPruneResult {
  const env = params.env ?? process.env;
  const pruneFlag = env.OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_PRUNE?.trim().toLowerCase();
  if (pruneFlag === "0" || pruneFlag === "false" || pruneFlag === "no" || pruneFlag === "off") {
    return { pruned: [], retained: [], skipped: "disabled" };
  }
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const keepCount = parseKeepCount(params.keepCount ?? env.OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_KEEP);
  const protectedRoots = collectProtectedReleaseRoots({
    rootDir,
    env,
    protectedRoots: params.protectedRoots,
  });
  const retained: GatewayRuntimeSnapshotPruneResult["retained"] = [];
  const pruned: GatewayRuntimeSnapshotPruneResult["pruned"] = [];
  for (const release of listSnapshotReleases({ rootDir })) {
    const releaseRoot = path.resolve(release.root);
    const protectedRelease = protectedRoots.has(releaseRoot);
    if (protectedRelease || retained.length < keepCount) {
      retained.push({
        releaseId: release.releaseId,
        root: release.root,
        protected: protectedRelease,
      });
      continue;
    }
    fs.rmSync(release.root, { recursive: true, force: true });
    pruned.push({ releaseId: release.releaseId, root: release.root });
  }
  return { keepCount, pruned, retained };
}

export function rollbackGatewayRuntimeSnapshot(params: {
  releaseId: string;
  rootDir?: string;
}): GatewayRuntimeSnapshotRollbackResult {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const releaseId = normalizeReleaseId(params.releaseId);
  const { releasesDir, latestPath } = resolveSnapshotPaths(rootDir);
  const releaseRoot = path.join(releasesDir, releaseId);
  if (!isUsableSnapshotRoot(releaseRoot)) {
    throw new Error(
      `Cannot roll back Gateway runtime snapshot; release is incomplete: ${releaseId}`,
    );
  }
  const existingSnapshot = readJsonFileIfPresent(path.join(releaseRoot, "snapshot.json"));
  const fallbackSnapshot = {
    version: 1,
    releaseId,
    root: releaseRoot,
    createdAt: new Date().toISOString(),
    source: { root: rootDir, buildStamp: null, runtimePostbuildStamp: null },
    paths: {
      entrypoint: path.join(releaseRoot, "dist", "index.js"),
      controlUi: path.join(releaseRoot, "dist", "control-ui"),
      bundledPlugins: path.join(releaseRoot, "dist-runtime", "extensions"),
    },
  };
  const snapshot = isRecord(existingSnapshot) ? existingSnapshot : fallbackSnapshot;
  writeJsonAtomic(latestPath, { ...snapshot, releaseId, root: releaseRoot });
  return { rolledBack: true, releaseId, releaseRoot, latestPath };
}
