import { existsSync, readFileSync } from "node:fs";
import path, { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listBundledPluginMetadata } from "../bundled-plugin-metadata.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CORE_PLUGIN_ENTRY_IMPORT_RE =
  /import\s*\{[^}]*\bdefinePluginEntry\b[^}]*\}\s*from\s*"openclaw\/plugin-sdk\/core"/;
const RUNTIME_ENTRY_HELPER_RE = /(^|\/)plugin-entry\.runtime\.[cm]?[jt]s$/;
const GUARDED_CONTRACT_ARTIFACT_BASENAMES = new Set([
  "channel-config-api.js",
  "contract-api.js",
  "secret-contract-api.js",
  "security-contract-api.js",
]);
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_CONTRACT_MODULE_SOURCE_PATTERNS = [
  /["']vitest["']/u,
  /["']openclaw\/plugin-sdk\/testing["']/u,
  /["'](?:\.{1,2}\/)+[^"']*test-api(?:\.[cm]?[jt]s)?["']/u,
  /["'](?:\.{1,2}\/)+[^"']*__tests__\/[^"']*["']/u,
  /["'](?:\.{1,2}\/)+[^"']*\.test-[^"']*["']/u,
  /["'](?:\.{1,2}\/)+[^"']*(?:test-harness|test-plugin|test-helper|harness)[^"']*["']/u,
] as const;
const FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS = [
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)test-api\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*\.test-[^/]*\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*(?:test-harness|test-plugin|test-helper|harness)[^/]*\.[cm]?[jt]s$/u,
] as const;
const EXPORT_FROM_RE = /\bexport\b[\s\S]*?\bfrom\s*["']([^"']+)["']/gu;

function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function resolvePublicSurfaceSourcePath(
  pluginDir: string,
  artifactBasename: string,
): string | null {
  const stem = artifactBasename.replace(/\.[^.]+$/u, "");
  for (const extension of SOURCE_MODULE_EXTENSIONS) {
    const candidate = resolve(pluginDir, `${stem}${extension}`);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Keep trying.
    }
  }
  return null;
}

function collectProductionContractEntryPaths(): Array<{ pluginId: string; entryPath: string }> {
  return listBundledPluginMetadata({ rootDir: REPO_ROOT }).flatMap((plugin) => {
    const pluginDir = resolve(REPO_ROOT, "extensions", plugin.dirName);
    const entryPaths = new Set<string>();
    for (const artifact of plugin.publicSurfaceArtifacts ?? []) {
      if (!GUARDED_CONTRACT_ARTIFACT_BASENAMES.has(artifact)) {
        continue;
      }
      const sourcePath = resolvePublicSurfaceSourcePath(pluginDir, artifact);
      if (sourcePath) {
        entryPaths.add(sourcePath);
      }
    }
    return [...entryPaths].map((entryPath) => ({
      pluginId: plugin.manifest.id,
      entryPath,
    }));
  });
}

function formatRepoRelativePath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

function collectRelativeReExportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  EXPORT_FROM_RE.lastIndex = 0;
  for (const match of source.matchAll(EXPORT_FROM_RE)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveRelativeSourceModulePath(fromPath: string, specifier: string): string | null {
  const rawTargetPath = resolve(dirname(fromPath), specifier);
  const candidates = new Set<string>();
  const rawExtension = path.extname(rawTargetPath);
  if (rawExtension) {
    candidates.add(rawTargetPath);
    const stem = rawTargetPath.slice(0, -rawExtension.length);
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${stem}${extension}`);
    }
  } else {
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${rawTargetPath}${extension}`);
      candidates.add(resolve(rawTargetPath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findForbiddenContractModuleGraphPaths(params: {
  entryPath: string;
  pluginDir: string;
}): string[] {
  const failures: string[] = [];
  const visited = new Set<string>();
  const pending = [params.entryPath];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const repoRelativePath = formatRepoRelativePath(currentPath);
    for (const pattern of FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS) {
      if (pattern.test(repoRelativePath)) {
        failures.push(`${repoRelativePath} matched ${pattern}`);
      }
    }

    const source = readFileSync(currentPath, "utf8");
    for (const pattern of FORBIDDEN_CONTRACT_MODULE_SOURCE_PATTERNS) {
      if (pattern.test(source)) {
        failures.push(`${repoRelativePath} matched ${pattern}`);
      }
    }

    for (const specifier of collectRelativeReExportSpecifiers(source)) {
      const resolvedModulePath = resolveRelativeSourceModulePath(currentPath, specifier);
      if (!resolvedModulePath) {
        continue;
      }
      if (resolvedModulePath === currentPath) {
        continue;
      }
      if (!resolvedModulePath.startsWith(params.pluginDir + path.sep)) {
        continue;
      }
      pending.push(resolvedModulePath);
    }
  }

  return failures;
}

describe("plugin entry guardrails", () => {
  it("keeps bundled extension entry modules off direct definePluginEntry imports from core", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const indexPath = resolve(plugin.rootDir, "index.ts");
      try {
        const source = readFileSync(indexPath, "utf8");
        if (CORE_PLUGIN_ENTRY_IMPORT_RE.test(source)) {
          failures.push(`extensions/${plugin.pluginId}/index.ts`);
        }
      } catch {
        // Skip extensions without index.ts entry modules.
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not advertise runtime helper sidecars as bundled plugin entry extensions", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const packageJsonPath = resolve(plugin.rootDir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: { extensions?: unknown };
        };
        const extensions = Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : [];
        if (
          extensions.some(
            (candidate) => typeof candidate === "string" && RUNTIME_ENTRY_HELPER_RE.test(candidate),
          )
        ) {
          failures.push(`extensions/${plugin.pluginId}/package.json`);
        }
      } catch {
        // Skip directories without package metadata.
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps bundled production contract barrels off test-only imports and re-exports", () => {
    const failures = collectProductionContractEntryPaths().flatMap(({ pluginId, entryPath }) =>
      findForbiddenContractModuleGraphPaths({
        entryPath,
        pluginDir: dirname(entryPath),
      }).map((failure) => `${pluginId}: ${failure}`),
    );

    expect(failures).toEqual([]);
  });
});
