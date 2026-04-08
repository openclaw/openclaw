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
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".cts"] as const;
const FORBIDDEN_CONTRACT_BARREL_PATTERNS = [
  /["']vitest["']/u,
  /["']openclaw\/plugin-sdk\/testing["']/u,
  /["']\.\/test-api\.js["']/u,
  /["'](?:__tests__\/|[^"']*\/__tests__\/)[^"']*["']/u,
  /["'][^"']*\.test-[^"']*["']/u,
  /["'][^"']*(?:test-harness|test-plugin|test-helper|harness)[^"']*["']/u,
] as const;

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

function findForbiddenContractBarrelPatterns(entryPath: string): string[] {
  const failures: string[] = [];
  const source = readFileSync(entryPath, "utf8");

  for (const pattern of FORBIDDEN_CONTRACT_BARREL_PATTERNS) {
    if (pattern.test(source)) {
      failures.push(`${entryPath.replace(`${REPO_ROOT}/`, "")} matched ${pattern}`);
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
      findForbiddenContractBarrelPatterns(entryPath).map(
        (failure) => `${pluginId}: ${failure.replace(`${REPO_ROOT}/`, "")}`,
      ),
    );

    expect(failures).toEqual([]);
  });
});
