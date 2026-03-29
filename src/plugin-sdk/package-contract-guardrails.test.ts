import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function readMatrixPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  openclaw?: {
    releaseChecks?: {
      rootDependencyMirrorAllowlist?: unknown;
    };
  };
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "extensions/matrix/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    openclaw?: {
      releaseChecks?: {
        rootDependencyMirrorAllowlist?: unknown;
      };
    };
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

function createRootPackageRequire() {
  return createRequire(pathToFileURL(resolve(REPO_ROOT, "package.json")).href);
}

function resolvePackageManagerCommand(name: "npm" | "pnpm"): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function packOpenClawToTempDir(packDir: string): string {
  const raw = execFileSync(
    resolvePackageManagerCommand("npm"),
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    },
  );
  const parsed = JSON.parse(raw) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename?.trim();
  if (!filename) {
    throw new Error(`npm pack did not return a filename: ${raw}`);
  }
  return join(packDir, filename);
}

function readGeneratedFacadeTypeMap(): string {
  return readFileSync(
    resolve(REPO_ROOT, "src/generated/plugin-sdk-facade-type-map.generated.ts"),
    "utf8",
  );
}

function buildLegacyPluginSourceAlias(): string {
  return ["openclaw", ["plugin", "source"].join("-")].join("/") + "/";
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
    const rootRuntimeDeps = collectRuntimeDependencySpecs(readRootPackageJson());
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);
    const allowlist = matrixPackageJson.openclaw?.releaseChecks?.rootDependencyMirrorAllowlist;

    expect(Array.isArray(allowlist)).toBe(true);
    const matrixRootMirrorAllowlist = allowlist as string[];
    expect(matrixRootMirrorAllowlist).toEqual(
      expect.arrayContaining(["@matrix-org/matrix-sdk-crypto-wasm"]),
    );

    for (const dep of matrixRootMirrorAllowlist) {
      expect(rootRuntimeDeps.get(dep)).toBe(matrixRuntimeDeps.get(dep));
    }
  });

  it("resolves matrix crypto WASM from the root runtime surface", () => {
    const rootRequire = createRootPackageRequire();

    expect(rootRequire.resolve("@matrix-org/matrix-sdk-crypto-wasm")).toContain(
      "@matrix-org/matrix-sdk-crypto-wasm",
    );
  });

  it("resolves matrix crypto WASM from an installed packed artifact", () => {
    const tempRoot = mkdtempSync(join(os.tmpdir(), "openclaw-matrix-wasm-pack-"));
    try {
      const packDir = join(tempRoot, "pack");
      const consumerDir = join(tempRoot, "consumer");
      mkdirSync(packDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });
      writeFileSync(
        join(consumerDir, "package.json"),
        `${JSON.stringify({ name: "matrix-wasm-smoke", private: true }, null, 2)}\n`,
        "utf8",
      );

      const archivePath = packOpenClawToTempDir(packDir);

      execFileSync(
        resolvePackageManagerCommand("pnpm"),
        ["add", "--offline", "--ignore-scripts", archivePath],
        {
          cwd: consumerDir,
          encoding: "utf8",
          env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const installedPackageJsonPath = join(
        consumerDir,
        "node_modules",
        "openclaw",
        "package.json",
      );
      const installedPackageJson = JSON.parse(readFileSync(installedPackageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const installedRequire = createRequire(pathToFileURL(installedPackageJsonPath).href);
      const matrixPackageJson = readMatrixPackageJson();

      expect(installedPackageJson.dependencies?.["@matrix-org/matrix-sdk-crypto-wasm"]).toBe(
        matrixPackageJson.dependencies?.["@matrix-org/matrix-sdk-crypto-wasm"],
      );
      expect(installedRequire.resolve("@matrix-org/matrix-sdk-crypto-wasm")).toContain(
        "@matrix-org/matrix-sdk-crypto-wasm",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps generated facade types on package-style module specifiers", () => {
    expect(readGeneratedFacadeTypeMap()).not.toContain("../../extensions/");
    expect(readGeneratedFacadeTypeMap()).not.toContain(buildLegacyPluginSourceAlias());
  });
});
