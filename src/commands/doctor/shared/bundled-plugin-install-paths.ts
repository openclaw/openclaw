import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  type BundledPluginSource,
  resolveBundledPluginSources,
} from "../../../plugins/bundled-sources.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { resolveUserPath } from "../../../utils.js";

type InstallPathField = "sourcePath" | "installPath";

type InstallFieldHit = {
  field: InstallPathField;
  previousPath: string;
};

type LoadPathHit = {
  index: number;
  previousPath: string;
};

export type BundledPluginInstallPathOptions = {
  env?: NodeJS.ProcessEnv;
  bundledSources?: ReadonlyMap<string, BundledPluginSource>;
  pathExists?: (absolutePath: string) => boolean;
};

export type BundledPluginInstallPathRepairHit = {
  pluginId: string;
  nextPath: string;
  installFieldHits: InstallFieldHit[];
  loadPathHits: LoadPathHit[];
};

function resolveFsPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveUserPath(value, env));
}

function resolveExistingRealPath(value: string): string | null {
  try {
    if (!fs.existsSync(value)) {
      return null;
    }
    return fs.realpathSync.native?.(value) ?? fs.realpathSync(value);
  } catch {
    return null;
  }
}

function pathsEqual(
  left: string | undefined,
  right: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!left || !right) {
    return false;
  }
  const resolvedLeft = resolveFsPath(left, env);
  const resolvedRight = resolveFsPath(right, env);
  if (resolvedLeft === resolvedRight) {
    return true;
  }
  const leftRealPath = resolveExistingRealPath(resolvedLeft);
  const rightRealPath = resolveExistingRealPath(resolvedRight);
  return Boolean(leftRealPath && rightRealPath && leftRealPath === rightRealPath);
}

function derivePackagePluginPathInfo(
  pluginPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { packageRoot: string; relativePath: string } | null {
  const resolvedPluginPath = resolveFsPath(pluginPath, env);
  const pluginLeaf = path.basename(resolvedPluginPath);
  const extensionsDir = path.dirname(resolvedPluginPath);
  if (path.basename(extensionsDir) !== "extensions") {
    return null;
  }
  const layoutRoot = path.dirname(extensionsDir);
  const layoutName = path.basename(layoutRoot);
  if (layoutName === "dist" || layoutName === "dist-runtime") {
    return {
      packageRoot: path.dirname(layoutRoot),
      relativePath: path.join(layoutName, "extensions", pluginLeaf),
    };
  }
  return {
    packageRoot: layoutRoot,
    relativePath: path.join("extensions", pluginLeaf),
  };
}

function isBundledRelativePluginPath(relativePath: string, bundledLeaf: string): boolean {
  const normalized = path.normalize(relativePath);
  return [
    path.join("extensions", bundledLeaf),
    path.join("dist", "extensions", bundledLeaf),
    path.join("dist-runtime", "extensions", bundledLeaf),
  ].includes(normalized);
}

function isStaleBundledPluginPath(params: {
  candidatePath: string;
  bundledPath: string;
  env: NodeJS.ProcessEnv;
  pathExists: (absolutePath: string) => boolean;
}): boolean {
  if (pathsEqual(params.candidatePath, params.bundledPath, params.env)) {
    return false;
  }

  const resolvedCandidatePath = resolveFsPath(params.candidatePath, params.env);
  if (params.pathExists(resolvedCandidatePath)) {
    return false;
  }

  const bundledPathInfo = derivePackagePluginPathInfo(params.bundledPath, params.env);
  const candidatePathInfo = derivePackagePluginPathInfo(params.candidatePath, params.env);
  if (!bundledPathInfo || !candidatePathInfo) {
    return false;
  }
  if (!pathsEqual(candidatePathInfo.packageRoot, bundledPathInfo.packageRoot, params.env)) {
    return false;
  }

  const bundledLeaf = path.basename(resolveFsPath(params.bundledPath, params.env));
  return isBundledRelativePluginPath(candidatePathInfo.relativePath, bundledLeaf);
}

function dedupePathEntries(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of paths) {
    const normalized = resolveFsPath(entry, env);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(entry);
  }
  return deduped;
}

export function scanBundledPluginInstallPathRepairs(
  cfg: OpenClawConfig,
  options: BundledPluginInstallPathOptions = {},
): BundledPluginInstallPathRepairHit[] {
  const env = options.env ?? process.env;
  const bundledSources =
    options.bundledSources ?? resolveBundledPluginSources({ env: options.env ?? process.env });
  const pathExists = options.pathExists ?? fs.existsSync;
  const installs = cfg.plugins?.installs ?? {};
  const loadPaths = cfg.plugins?.load?.paths ?? [];
  const hits: BundledPluginInstallPathRepairHit[] = [];

  for (const [pluginId, install] of Object.entries(installs)) {
    if (!install || install.source !== "path") {
      continue;
    }

    const bundledSource = bundledSources.get(pluginId);
    if (!bundledSource) {
      continue;
    }

    const installFieldHits: InstallFieldHit[] = [];
    for (const field of ["sourcePath", "installPath"] as const) {
      const currentPath = typeof install[field] === "string" ? install[field].trim() : "";
      if (!currentPath) {
        continue;
      }
      if (
        isStaleBundledPluginPath({
          candidatePath: currentPath,
          bundledPath: bundledSource.localPath,
          env,
          pathExists,
        })
      ) {
        installFieldHits.push({ field, previousPath: currentPath });
      }
    }

    const loadPathHits: LoadPathHit[] = [];
    for (const [index, loadPath] of loadPaths.entries()) {
      if (typeof loadPath !== "string" || !loadPath.trim()) {
        continue;
      }
      if (
        isStaleBundledPluginPath({
          candidatePath: loadPath,
          bundledPath: bundledSource.localPath,
          env,
          pathExists,
        })
      ) {
        loadPathHits.push({ index, previousPath: loadPath });
      }
    }

    if (installFieldHits.length === 0 && loadPathHits.length === 0) {
      continue;
    }

    hits.push({
      pluginId,
      nextPath: bundledSource.localPath,
      installFieldHits,
      loadPathHits,
    });
  }

  return hits;
}

export function collectBundledPluginInstallPathWarnings(params: {
  hits: BundledPluginInstallPathRepairHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }

  return params.hits.map((hit) =>
    [
      `- Bundled plugin "${hit.pluginId}" now resolves to ${hit.nextPath}, but config still points at stale path references.`,
      ...hit.installFieldHits.map(
        (fieldHit) =>
          `- plugins.installs.${hit.pluginId}.${fieldHit.field}: ${fieldHit.previousPath}`,
      ),
      ...hit.loadPathHits.map(
        (loadPathHit) => `- plugins.load.paths[${loadPathHit.index}]: ${loadPathHit.previousPath}`,
      ),
      `- Run "${params.doctorFixCommand}" to update stale bundled plugin path references.`,
    ]
      .map((line) => sanitizeForLog(line))
      .join("\n"),
  );
}

export function maybeRepairBundledPluginInstallPaths(
  cfg: OpenClawConfig,
  options: BundledPluginInstallPathOptions = {},
): {
  config: OpenClawConfig;
  changes: string[];
} {
  const env = options.env ?? process.env;
  const hits = scanBundledPluginInstallPathRepairs(cfg, options);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  const nextLoadPaths = [...(next.plugins?.load?.paths ?? [])];
  let loadPathsChanged = false;

  for (const hit of hits) {
    const install = next.plugins?.installs?.[hit.pluginId];
    if (!install || install.source !== "path") {
      continue;
    }

    for (const fieldHit of hit.installFieldHits) {
      const field = fieldHit.field;
      const previousPath = typeof install[field] === "string" ? install[field] : "(unset)";
      if (pathsEqual(previousPath, hit.nextPath, env)) {
        continue;
      }
      install[field] = hit.nextPath;
      changes.push(
        `- plugins.installs.${hit.pluginId}.${field}: updated stale bundled path from ${previousPath} -> ${hit.nextPath}`,
      );
    }

    for (const loadPathHit of hit.loadPathHits) {
      if (pathsEqual(nextLoadPaths[loadPathHit.index], hit.nextPath, env)) {
        continue;
      }
      nextLoadPaths[loadPathHit.index] = hit.nextPath;
      loadPathsChanged = true;
      changes.push(
        `- plugins.load.paths[${loadPathHit.index}]: updated stale bundled path from ${loadPathHit.previousPath} -> ${hit.nextPath}`,
      );
    }
  }

  if (loadPathsChanged) {
    next.plugins = {
      ...next.plugins,
      load: {
        ...next.plugins?.load,
        paths: dedupePathEntries(nextLoadPaths, env),
      },
    };
  }

  return changes.length === 0 ? { config: cfg, changes: [] } : { config: next, changes };
}
