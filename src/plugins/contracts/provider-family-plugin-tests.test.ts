import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_ROOT_DIR, bundledPluginRoot } from "../../../test/helpers/bundled-plugin-paths.js";

type SharedFamilyHookKind = "replay" | "stream" | "tool-compat";

type SharedFamilyProviderInventory = {
  hookKinds: Set<SharedFamilyHookKind>;
  sourceFiles: Set<string>;
};

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const EXTENSIONS_DIR = resolve(REPO_ROOT, BUNDLED_PLUGIN_ROOT_DIR);
const SHARED_FAMILY_HOOK_PATTERNS: ReadonlyArray<{
  kind: SharedFamilyHookKind;
  regex: RegExp;
}> = [
  { kind: "replay", regex: /\bbuildProviderReplayFamilyHooks\s*\(/u },
  { kind: "stream", regex: /\bbuildProviderStreamFamilyHooks\s*\(/u },
  { kind: "tool-compat", regex: /\bbuildProviderToolCompatFamilyHooks\s*\(/u },
];
const PROVIDER_BOUNDARY_TEST_SIGNALS = [
  /\bregister(?:Single)?ProviderPlugin\s*\(/u,
  /\bcreateTestPluginApi\s*\(/u,
] as const;

function toRepoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }

  return files;
}

function resolveBundledPluginId(filePath: string): string | null {
  const relativePath = relative(EXTENSIONS_DIR, filePath).split(sep).join("/");
  const [pluginId] = relativePath.split("/");
  return pluginId || null;
}

function collectSharedFamilyProviders(): Map<string, SharedFamilyProviderInventory> {
  const inventory = new Map<string, SharedFamilyProviderInventory>();

  for (const filePath of listFiles(EXTENSIONS_DIR)) {
    if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    const matchedKinds = SHARED_FAMILY_HOOK_PATTERNS.filter(({ regex }) => regex.test(source));
    if (matchedKinds.length === 0) {
      continue;
    }
    const pluginId = resolveBundledPluginId(filePath);
    if (!pluginId) {
      continue;
    }
    const entry = inventory.get(pluginId) ?? {
      hookKinds: new Set<SharedFamilyHookKind>(),
      sourceFiles: new Set<string>(),
    };
    for (const { kind } of matchedKinds) {
      entry.hookKinds.add(kind);
    }
    entry.sourceFiles.add(toRepoRelative(filePath));
    inventory.set(pluginId, entry);
  }

  return inventory;
}

function collectProviderBoundaryTests(): Map<string, Set<string>> {
  const inventory = new Map<string, Set<string>>();

  for (const filePath of listFiles(EXTENSIONS_DIR)) {
    if (!filePath.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    if (!PROVIDER_BOUNDARY_TEST_SIGNALS.some((signal) => signal.test(source))) {
      continue;
    }
    const pluginId = resolveBundledPluginId(filePath);
    if (!pluginId) {
      continue;
    }
    const tests = inventory.get(pluginId) ?? new Set<string>();
    tests.add(toRepoRelative(filePath));
    inventory.set(pluginId, tests);
  }

  return inventory;
}

describe("provider family plugin-boundary inventory", () => {
  it("keeps shared-family provider hooks covered by at least one plugin-boundary test", () => {
    const sharedFamilyProviders = collectSharedFamilyProviders();
    const providerBoundaryTests = collectProviderBoundaryTests();

    const missing = [...sharedFamilyProviders.entries()]
      .filter(([pluginId]) => !providerBoundaryTests.has(pluginId))
      .map(([pluginId, inventory]) => {
        const hookKinds = [...inventory.hookKinds].toSorted().join(", ");
        const sourceFiles = [...inventory.sourceFiles].toSorted().join(", ");
        return `${bundledPluginRoot(pluginId)} declares shared ${hookKinds} hooks but has no plugin-boundary provider test. Sources: ${sourceFiles}`;
      });

    expect(missing).toEqual([]);
  });
});
