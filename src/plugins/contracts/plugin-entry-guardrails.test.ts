import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
const TEST_ONLY_MODULE_SPECIFIER_RE =
  /^(?:vitest|openclaw\/plugin-sdk\/testing)$|(?:^|\/)(?:test-api|test-)|\.test-|(?:^|\/)__tests__(?:\/|$)/u;

function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function collectModuleSpecifiers(text: string): string[] {
  const patterns = [
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ] as const;
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function isTestLikeModulePath(path: string): boolean {
  return (
    /(?:^|\/)test-api\.[cm]?[jt]s$/u.test(path) ||
    /(?:^|\/)test-[^/]*\.[cm]?[jt]s$/u.test(path) ||
    /\.test-[^/]*\.[cm]?[jt]s$/u.test(path) ||
    /(?:^|\/)__tests__(?:\/|$)/u.test(path) ||
    /(?:\.test|\.spec)\.[cm]?[jt]s$/u.test(path)
  );
}

function resolveRelativeModulePath(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const basePath = resolve(fromFile, "..", specifier);
  for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const withExtension = `${basePath}${extension}`;
    try {
      readFileSync(withExtension, "utf8");
      return withExtension;
    } catch {
      // Keep trying.
    }
  }
  for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const indexPath = resolve(basePath, `index${extension}`);
    try {
      readFileSync(indexPath, "utf8");
      return indexPath;
    } catch {
      // Keep trying.
    }
  }
  try {
    readFileSync(basePath, "utf8");
    return basePath;
  } catch {
    return null;
  }
}

function resolvePublicSurfaceSourcePath(
  pluginDir: string,
  artifactBasename: string,
): string | null {
  const stem = artifactBasename.replace(/\.[^.]+$/u, "");
  for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
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

function findTestOnlyDependencies(entryPath: string): string[] {
  const failures = new Set<string>();
  const visited = new Set<string>();
  const stack = [entryPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const source = readFileSync(current, "utf8");

    for (const specifier of collectModuleSpecifiers(source)) {
      if (TEST_ONLY_MODULE_SPECIFIER_RE.test(specifier)) {
        failures.add(`${current.replace(`${REPO_ROOT}/`, "")} -> ${specifier}`);
        continue;
      }
      const resolved = resolveRelativeModulePath(specifier, current);
      if (!resolved) {
        continue;
      }
      if (isTestLikeModulePath(resolved)) {
        failures.add(
          `${current.replace(`${REPO_ROOT}/`, "")} -> ${resolved.replace(`${REPO_ROOT}/`, "")}`,
        );
        continue;
      }
      stack.push(resolved);
    }
  }

  return [...failures].toSorted((left, right) => left.localeCompare(right));
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

  it("keeps bundled production public barrels free of test-only dependency graphs", () => {
    const failures = collectProductionContractEntryPaths().flatMap(({ pluginId, entryPath }) =>
      findTestOnlyDependencies(entryPath).map(
        (failure) => `${pluginId}: ${failure.replace(`${REPO_ROOT}/`, "")}`,
      ),
    );

    expect(failures).toEqual([]);
  });
});
