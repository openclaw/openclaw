import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  pluginSdkEntrypoints,
  publicPluginOwnedSdkEntrypoints,
  reservedBundledPluginSdkEntrypoints,
  supportedBundledFacadeSdkEntrypoints,
} from "../../plugin-sdk/entrypoints.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const SDK_SUBPATH_DOC_FILE = "docs/plugins/sdk-subpaths.md";
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;
const BUNDLED_PLUGIN_FACADE_LOADER_PATTERN =
  /\bload(?:Activated)?BundledPluginPublicSurfaceModuleSync\b/;
const PRIVATE_BUNDLED_SDK_SURFACE_PATTERN =
  /\b(?:Private helper surface|Narrow plugin-sdk surface for the bundled|Narrow .*runtime exports used by the bundled)\b/i;
const GENERIC_CORE_HELPER_FILES = ["src/polls.ts", "src/poll-params.ts"] as const;
const GENERIC_CORE_PLUGIN_OWNER_NAME_PATTERN =
  /\b(?:bluebubbles|discord|feishu|googlechat|matrix|mattermost|msteams|slack|telegram|whatsapp|zalo|zalouser)\b/gi;

function collectPluginSdkPackageExports(): string[] {
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const exports = packageJson.exports ?? {};
  const subpaths: string[] = [];
  for (const key of Object.keys(exports)) {
    if (key === "./plugin-sdk") {
      subpaths.push("index");
      continue;
    }
    if (!key.startsWith("./plugin-sdk/")) {
      continue;
    }
    subpaths.push(key.slice("./plugin-sdk/".length));
  }
  return subpaths.toSorted();
}

function collectPluginSdkSubpathReferences() {
  const references: Array<{ file: string; subpath: string }> = [];
  for (const file of PUBLIC_CONTRACT_REFERENCE_FILES) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(PLUGIN_SDK_SUBPATH_PATTERN)) {
      const subpath = match[1];
      if (!subpath) {
        continue;
      }
      references.push({ file, subpath });
    }
  }
  return references;
}

function collectDocumentedSdkSubpaths(): Set<string> {
  const source = readFileSync(resolve(REPO_ROOT, SDK_SUBPATH_DOC_FILE), "utf8");
  return new Set(
    [...source.matchAll(/`plugin-sdk\/([a-z0-9][a-z0-9-]*)`/g)]
      .map((match) => match[1])
      .filter((subpath): subpath is string => Boolean(subpath)),
  );
}

function collectBundledPluginIds(): string[] {
  return readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

function collectPluginOwnedSdkEntrypoints(): string[] {
  const pluginIds = collectBundledPluginIds();
  return pluginSdkEntrypoints
    .filter((entrypoint) =>
      pluginIds.some(
        (pluginId) => entrypoint === pluginId || entrypoint.startsWith(`${pluginId}-`),
      ),
    )
    .toSorted();
}

function resolvePluginOwnerFromEntrypoint(entrypoint: string): string | undefined {
  return collectBundledPluginIds().find(
    (pluginId) => entrypoint === pluginId || entrypoint.startsWith(`${pluginId}-`),
  );
}

function collectClassificationOverlaps(classifications: Record<string, readonly string[]>) {
  const seen = new Map<string, string[]>();
  for (const [classification, entrypoints] of Object.entries(classifications)) {
    for (const entrypoint of entrypoints) {
      const current = seen.get(entrypoint) ?? [];
      current.push(classification);
      seen.set(entrypoint, current);
    }
  }
  return [...seen.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([entrypoint, matches]) => `${entrypoint}: ${matches.toSorted().join(", ")}`)
    .toSorted();
}

function collectBundledFacadeSdkEntrypoints(): string[] {
  const entrypoints: string[] = [];
  for (const entrypoint of pluginSdkEntrypoints) {
    const filePath = resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`);
    const source = readFileSync(filePath, "utf8");
    if (BUNDLED_PLUGIN_FACADE_LOADER_PATTERN.test(source)) {
      entrypoints.push(entrypoint);
    }
  }
  return entrypoints.toSorted();
}

function collectPrivateBundledSdkSurfaceEntrypoints(): string[] {
  const entrypoints: string[] = [];
  for (const entrypoint of pluginSdkEntrypoints) {
    const filePath = resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`);
    const source = readFileSync(filePath, "utf8");
    if (PRIVATE_BUNDLED_SDK_SURFACE_PATTERN.test(source)) {
      entrypoints.push(entrypoint);
    }
  }
  return entrypoints.toSorted();
}

function collectGenericCoreOwnerNameLeaks(): Array<{ file: string; match: string }> {
  const leaks: Array<{ file: string; match: string }> = [];
  for (const file of GENERIC_CORE_HELPER_FILES) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(GENERIC_CORE_PLUGIN_OWNER_NAME_PATTERN)) {
      const ownerName = match[0];
      if (!ownerName) {
        continue;
      }
      leaks.push({ file, match: ownerName });
    }
  }
  return leaks;
}

function readRootPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function readMatrixPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "extensions/matrix/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function collectRuntimeDependencySpecs(packageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): Map<string, string> {
  return new Map([
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.optionalDependencies ?? {}),
  ]);
}

function collectExtensionFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectExtensionFiles(nextPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?ts|tsx|mts|cts)$/.test(entry.name)) {
      continue;
    }
    files.push(nextPath);
  }
  return files;
}

function collectExtensionCoreImportLeaks(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']((?:\.\.\/)+src\/[^"']+)["']/g;
  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (
      /(?:^|\/)(?:__tests__|tests|test-support)(?:\/|$)/.test(repoRelativePath) ||
      /(?:^|\/)test-support\.[cm]?tsx?$/.test(repoRelativePath) ||
      /\.test-support\.[cm]?tsx?$/.test(repoRelativePath) ||
      /\.test\.[cm]?tsx?$/.test(repoRelativePath)
    ) {
      continue;
    }
    const extensionRootMatch = /^(.*?\/extensions\/[^/]+)/.exec(file.replaceAll("\\", "/"));
    const extensionRoot = extensionRootMatch?.[1];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const resolvedSpecifier = resolve(dirname(file), specifier).replaceAll("\\", "/");
      if (extensionRoot && resolvedSpecifier.startsWith(`${extensionRoot}/`)) {
        continue;
      }
      leaks.push({
        file: repoRelativePath,
        specifier,
      });
    }
  }
  return leaks;
}

function collectCrossOwnerReservedSdkImports(): Array<{
  file: string;
  specifier: string;
  owner?: string;
}> {
  const leaks: Array<{ file: string; specifier: string; owner?: string }> = [];
  const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
  const importPattern =
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g;

  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    const pluginId = repoRelativePath.split("/")[1];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const subpath = match[1];
      if (!subpath || !reserved.has(subpath)) {
        continue;
      }
      const owner = resolvePluginOwnerFromEntrypoint(subpath);
      if (owner === pluginId) {
        continue;
      }
      leaks.push({
        file: repoRelativePath,
        specifier: `openclaw/plugin-sdk/${subpath}`,
        owner,
      });
    }
  }
  return leaks;
}

describe("plugin-sdk package contract guardrails", () => {
  it("keeps plugin-sdk entrypoint metadata unique", () => {
    const counts = new Map<string, number>();
    for (const entrypoint of pluginSdkEntrypoints) {
      counts.set(entrypoint, (counts.get(entrypoint) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([entrypoint]) => entrypoint)
      .toSorted();

    expect(duplicates).toEqual([]);
  });

  it("keeps package.json exports aligned with built plugin-sdk entrypoints", () => {
    expect(collectPluginSdkPackageExports()).toEqual([...pluginSdkEntrypoints].toSorted());
  });

  it("keeps bundled plugin SDK compatibility subpaths explicitly classified", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const unknownReserved = [...reserved].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unknownSupported = [...supported].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unclassifiedBundledFacades = collectBundledFacadeSdkEntrypoints().filter(
      (entrypoint) => !reserved.has(entrypoint) && !supported.has(entrypoint),
    );
    const unreservedPrivateSurfaces = collectPrivateBundledSdkSurfaceEntrypoints().filter(
      (entrypoint) => !reserved.has(entrypoint),
    );

    expect({
      unknownReserved,
      unknownSupported,
      unclassifiedBundledFacades,
      unreservedPrivateSurfaces,
    }).toEqual({
      unknownReserved: [],
      unknownSupported: [],
      unclassifiedBundledFacades: [],
      unreservedPrivateSurfaces: [],
    });
  });

  it("keeps plugin-owned SDK subpaths explicitly classified and documented", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const publicOwned = new Set<string>(publicPluginOwnedSdkEntrypoints);
    const documented = collectDocumentedSdkSubpaths();
    const pluginOwnedEntrypoints = collectPluginOwnedSdkEntrypoints();
    const classified = new Set([...reserved, ...supported, ...publicOwned]);

    const unknownPublicOwned = [...publicOwned].filter(
      (entrypoint) => !entrypoints.has(entrypoint),
    );
    const classificationOverlaps = collectClassificationOverlaps({
      reserved: reservedBundledPluginSdkEntrypoints,
      supported: supportedBundledFacadeSdkEntrypoints,
      publicOwned: publicPluginOwnedSdkEntrypoints,
    });
    const unclassifiedPluginOwned = pluginOwnedEntrypoints.filter(
      (entrypoint) => !classified.has(entrypoint),
    );
    const undocumentedPluginOwned = pluginOwnedEntrypoints.filter(
      (entrypoint) => !documented.has(entrypoint),
    );

    expect({
      unknownPublicOwned,
      classificationOverlaps,
      unclassifiedPluginOwned,
      undocumentedPluginOwned,
    }).toEqual({
      unknownPublicOwned: [],
      classificationOverlaps: [],
      unclassifiedPluginOwned: [],
      undocumentedPluginOwned: [],
    });
  });

  it("keeps curated public plugin-sdk references on exported built subpaths", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const exports = new Set(collectPluginSdkPackageExports());
    const failures: string[] = [];

    for (const reference of collectPluginSdkSubpathReferences()) {
      const missingFrom: string[] = [];
      if (!entrypoints.has(reference.subpath)) {
        missingFrom.push("scripts/lib/plugin-sdk-entrypoints.json");
      }
      if (!exports.has(reference.subpath)) {
        missingFrom.push("package.json exports");
      }
      if (missingFrom.length === 0) {
        continue;
      }
      failures.push(
        `${reference.file} references openclaw/plugin-sdk/${reference.subpath}, but ${reference.subpath} is missing from ${missingFrom.join(" and ")}`,
      );
    }

    expect(failures).toEqual([]);
  });

  it("keeps Matrix runtime deps local to the Matrix plugin", () => {
    const rootRuntimeDeps = collectRuntimeDependencySpecs(readRootPackageJson());
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);

    for (const dep of [
      "@matrix-org/matrix-sdk-crypto-wasm",
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "fake-indexeddb",
      "matrix-js-sdk",
    ]) {
      expect(matrixRuntimeDeps.get(dep)).toBeDefined();
      expect(rootRuntimeDeps.has(dep)).toBe(false);
    }
    expect(rootRuntimeDeps.has("@openclaw/plugin-package-contract")).toBe(false);
  });

  it("keeps extension sources on public sdk or local package seams", () => {
    expect(collectExtensionCoreImportLeaks()).toEqual([]);
  });

  it("keeps reserved SDK compatibility subpaths inside their owning bundled plugins", () => {
    expect(collectCrossOwnerReservedSdkImports()).toEqual([]);
  });

  it("keeps generic core poll helpers free of plugin owner names", () => {
    expect(collectGenericCoreOwnerNameLeaks()).toEqual([]);
  });
});
