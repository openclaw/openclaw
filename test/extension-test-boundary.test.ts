import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../src/plugins/public-artifacts.js";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./helpers/bundled-plugin-paths.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES = new Set(
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
);

const allowedNonExtensionTests = new Set<string>([
  "src/agents/pi-embedded-runner-extraparams.test.ts",
  "src/channels/plugins/contracts/dm-policy.contract.test.ts",
  "src/channels/plugins/contracts/group-policy.contract.test.ts",
  "src/plugins/contracts/discovery.contract.test.ts",
]);

function walk(dir: string, entries: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      walk(fullPath, entries);
      continue;
    }
    if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      continue;
    }
    entries.push(path.relative(repoRoot, fullPath).replaceAll(path.sep, "/"));
  }
  return entries;
}

function findExtensionImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']((?:\.\.\/)+extensions\/[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["']((?:\.\.\/)+extensions\/[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function findPluginSdkImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function getImportBasename(importPath: string): string {
  return importPath.split("/").at(-1) ?? importPath;
}

function isAllowedCoreContractSuite(file: string, imports: readonly string[]): boolean {
  return (
    file.startsWith("src/channels/plugins/contracts/") &&
    file.endsWith(".contract.test.ts") &&
    imports.every((entry) =>
      ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES.has(getImportBasename(entry)),
    )
  );
}

describe("non-extension test boundaries", () => {
  it("keeps plugin-owned behavior suites under the bundled plugin tree", () => {
    const testFiles = [
      ...walk(path.join(repoRoot, "src")),
      ...walk(path.join(repoRoot, "test")),
      ...walk(path.join(repoRoot, "packages")),
    ].filter(
      (file) =>
        !file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
        !file.startsWith("test/helpers/") &&
        !file.startsWith("ui/"),
    );

    const offenders = testFiles
      .map((file) => {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const imports = findExtensionImports(source);
        if (imports.length === 0) {
          return null;
        }
        if (allowedNonExtensionTests.has(file) || isAllowedCoreContractSuite(file, imports)) {
          return null;
        }
        return {
          file,
          imports,
        };
      })
      .filter((value): value is { file: string; imports: string[] } => value !== null);

    expect(offenders).toEqual([]);
  });

  it("keeps extension-owned onboard helper coverage out of the core onboard auth suite", () => {
    const bannedPluginSdkModules = new Set<string>([
      "../plugin-sdk/litellm.js",
      "../plugin-sdk/minimax.js",
      "../plugin-sdk/mistral.js",
      "../plugin-sdk/opencode-go.js",
      "../plugin-sdk/opencode.js",
      "../plugin-sdk/openrouter.js",
      "../plugin-sdk/synthetic.js",
      "../plugin-sdk/xai.js",
      "../plugin-sdk/xiaomi.js",
      "../plugin-sdk/zai.js",
    ]);
    const file = "src/commands/onboard-auth.test.ts";
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const imports = findPluginSdkImports(source).filter((entry) =>
      bannedPluginSdkModules.has(entry),
    );

    expect(imports).toEqual([]);
  });
});
