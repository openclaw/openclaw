import fs from "node:fs";
import path from "node:path";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getPackageManifestMetadata,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import { formatPosixMode, isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import type { PluginDiagnostic, PluginOrigin } from "./types.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

export type PluginCandidate = {
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

function currentUid(overrideUid?: number | null): number | null {
  if (overrideUid !== undefined) {
    return overrideUid;
  }
  if (process.platform === "win32") {
    return null;
  }
  if (typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

export type CandidateBlockReason =
  | "source_escapes_root"
  | "path_stat_failed"
  | "path_world_writable"
  | "path_suspicious_ownership";

type CandidateBlockIssue = {
  reason: CandidateBlockReason;
  sourcePath: string;
  rootPath: string;
  targetPath: string;
  sourceRealPath?: string;
  rootRealPath?: string;
  modeBits?: number;
  foundUid?: number;
  expectedUid?: number;
};

function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source);
  const rootRealPath = safeRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

function checkPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  const seen = new Set<string>();
  for (const targetPath of pathsToCheck) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const stat = safeStatSync(targetPath);
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    const modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}

function findCandidateBlockIssue(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
}): CandidateBlockIssue | null {
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
  });
  if (escaped) {
    return escaped;
  }
  return checkPathStatAndPermissions({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    uid: currentUid(params.ownershipUid),
  });
}

function formatCandidateBlockMessage(issue: CandidateBlockIssue): string {
  if (issue.reason === "source_escapes_root") {
    return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
  }
  if (issue.reason === "path_stat_failed") {
    return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
  }
  if (issue.reason === "path_world_writable") {
    return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
  }
  return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}

function isUnsafePluginCandidate(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  diagnostics: PluginDiagnostic[];
  ownershipUid?: number | null;
}): boolean {
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
  });
  if (!issue) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    source: issue.targetPath,
    message: formatCandidateBlockMessage(issue),
  });
  return true;
}

function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!EXTENSION_EXTS.has(ext)) {
    return false;
  }
  return !filePath.endsWith(".d.ts");
}

function readPackageManifest(dir: string): PackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

function resolvePackageExtensions(manifest: PackageManifest): string[] {
  const raw = getPackageManifestMetadata(manifest)?.extensions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function deriveIdHint(params: {
  filePath: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @openclaw/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;

  if (!params.hasMultipleExtensions) {
    return unscoped;
  }
  return `${unscoped}/${base}`;
}

function addCandidate(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
}) {
  const resolved = path.resolve(params.source);
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot = path.resolve(params.rootDir);
  if (
    isUnsafePluginCandidate({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
    })
  ) {
    return;
  }
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    rootDir: resolvedRoot,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    packageName: manifest?.name?.trim() || undefined,
    packageVersion: manifest?.version?.trim() || undefined,
    packageDescription: manifest?.description?.trim() || undefined,
    packageDir: params.packageDir,
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
  });
}

function resolvePackageEntrySource(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  if (
    !isPathInsideWithRealpath(params.packageDir, source, {
      requireRealpath: true,
    })
  ) {
    params.diagnostics.push({
      level: "error",
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  return source;
}

function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
      });
    }
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = readPackageManifest(fullPath);
    const extensions = manifest ? resolvePackageExtensions(manifest) : [];

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const resolved = resolvePackageEntrySource({
          packageDir: fullPath,
          entryPath: extPath,
          sourceLabel: fullPath,
          diagnostics: params.diagnostics,
        });
        if (!resolved) {
          continue;
        }
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
        });
      }
      continue;
    }

    const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
    const indexFile = indexCandidates
      .map((candidate) => path.join(fullPath, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
      });
    }
  }
}

function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  const resolved = resolveUserPath(params.rawPath);
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    addCandidate({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
    });
    return;
  }

  if (stat.isDirectory()) {
    const manifest = readPackageManifest(resolved);
    const extensions = manifest ? resolvePackageExtensions(manifest) : [];

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const source = resolvePackageEntrySource({
          packageDir: resolved,
          entryPath: extPath,
          sourceLabel: resolved,
          diagnostics: params.diagnostics,
        });
        if (!source) {
          continue;
        }
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
        });
      }
      return;
    }

    const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
    const indexFile = indexCandidates
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
      });
      return;
    }

    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    return;
  }
}

export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const seen = new Set<string>();
  const workspaceDir = params.workspaceDir?.trim();

  const extra = params.extraPaths ?? [];
  for (const extraPath of extra) {
    if (typeof extraPath !== "string") {
      continue;
    }
    const trimmed = extraPath.trim();
    if (!trimmed) {
      continue;
    }
    discoverFromPath({
      rawPath: trimmed,
      origin: "config",
      ownershipUid: params.ownershipUid,
      workspaceDir: workspaceDir?.trim() || undefined,
      candidates,
      diagnostics,
      seen,
    });
  }
  if (workspaceDir) {
    const workspaceRoot = resolveUserPath(workspaceDir);
    const workspaceExtDirs = [path.join(workspaceRoot, ".openclaw", "extensions")];
    for (const dir of workspaceExtDirs) {
      discoverInDirectory({
        dir,
        origin: "workspace",
        ownershipUid: params.ownershipUid,
        workspaceDir: workspaceRoot,
        candidates,
        diagnostics,
        seen,
      });
    }
  }

  const globalDir = path.join(resolveConfigDir(), "extensions");
  discoverInDirectory({
    dir: globalDir,
    origin: "global",
    ownershipUid: params.ownershipUid,
    candidates,
    diagnostics,
    seen,
  });

  const bundledDir = resolveBundledPluginsDir();
  if (bundledDir) {
    discoverInDirectory({
      dir: bundledDir,
      origin: "bundled",
      ownershipUid: params.ownershipUid,
      candidates,
      diagnostics,
      seen,
    });
  }

  return { candidates, diagnostics };
}
