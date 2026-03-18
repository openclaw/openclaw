import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginSdkEntrypoints } from "./entrypoints.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const REFERENCE_SCAN_ROOTS = ["src", "extensions", "scripts", "test", "docs"] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;

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

function collectPluginSdkSourceNames(): string[] {
  const pluginSdkDir = resolve(REPO_ROOT, "src", "plugin-sdk");
  return readdirSync(pluginSdkDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name.slice(0, -".ts".length))
    .toSorted();
}

function collectTextFiles(rootRelativeDir: string): string[] {
  const rootDir = resolve(REPO_ROOT, rootRelativeDir);
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        /\.(?:[cm]?ts|[cm]?js|tsx|jsx|md|mdx|json)$/u.test(entry.name) &&
        !entry.name.endsWith(".snap")
      ) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function collectPluginSdkSubpathReferences() {
  const references: Array<{ file: string; subpath: string }> = [];
  for (const rootRelativeDir of REFERENCE_SCAN_ROOTS) {
    for (const fullPath of collectTextFiles(rootRelativeDir)) {
      const source = readFileSync(fullPath, "utf8");
      for (const match of source.matchAll(PLUGIN_SDK_SUBPATH_PATTERN)) {
        const subpath = match[1];
        if (!subpath) {
          continue;
        }
        references.push({
          file: relative(REPO_ROOT, fullPath).replaceAll("\\", "/"),
          subpath,
        });
      }
    }
  }
  return references;
}

describe("plugin-sdk package contract guardrails", () => {
  it("keeps package.json exports aligned with built plugin-sdk entrypoints", () => {
    expect(collectPluginSdkPackageExports()).toEqual([...pluginSdkEntrypoints].toSorted());
  });

  it("keeps repo openclaw/plugin-sdk/<name> references on exported built subpaths", () => {
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

  it("does not leave referenced src/plugin-sdk source names stranded outside the public contract", () => {
    const exported = new Set(pluginSdkEntrypoints);
    const references = collectPluginSdkSubpathReferences();
    const failures: string[] = [];

    for (const sourceName of collectPluginSdkSourceNames()) {
      if (exported.has(sourceName) || sourceName === "compat" || sourceName === "index") {
        continue;
      }
      const matchingRefs = references.filter((reference) => reference.subpath === sourceName);
      if (matchingRefs.length === 0) {
        continue;
      }
      failures.push(
        `src/plugin-sdk/${sourceName}.ts is referenced as openclaw/plugin-sdk/${sourceName} in ${matchingRefs
          .map((reference) => reference.file)
          .toSorted()
          .join(", ")}, but ${sourceName} is not exported as a public plugin-sdk subpath`,
      );
    }

    expect(failures).toEqual([]);
  });
});
