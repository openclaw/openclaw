import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginSdkEntrypoints } from "./entrypoints.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugin-sdk/subpaths.test.ts",
] as const;
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

function readRootPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

describe("plugin-sdk package contract guardrails", () => {
  it("keeps package.json exports aligned with built plugin-sdk entrypoints", () => {
    expect(collectPluginSdkPackageExports()).toEqual([...pluginSdkEntrypoints].toSorted());
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

  it("mirrors matrix runtime deps needed by the bundled host graph", () => {
    const { dependencies = {}, optionalDependencies = {} } = readRootPackageJson();

    expect(dependencies["matrix-js-sdk"]).toBe("41.2.0");
    expect(optionalDependencies["@matrix-org/matrix-sdk-crypto-nodejs"]).toBe("^0.4.0");
  });
});
