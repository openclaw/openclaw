// Extension package boundary tests cover package/project boundaries for bundled extensions.
import fs from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../../scripts/lib/plugin-sdk-entries.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG =
  "extensions/tsconfig.package-boundary.paths.json" as const;
const EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG =
  "extensions/tsconfig.package-boundary.base.json" as const;
const XAI_OMITTED_BOUNDARY_PATHS = {
  "openclaw/plugin-sdk/browser-maintenance": [
    "../packages/plugin-sdk/dist/extensions/browser/browser-maintenance.d.ts",
  ],
  "openclaw/plugin-sdk/channel-secret-owner-runtime": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/channel-secret-owner-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/channel-secret-tts-runtime": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/channel-secret-tts-runtime.d.ts",
  ],
  "@openclaw/matrix/test-api.js": [
    "../.artifacts/extension-package-boundary/plugins/matrix/test-api.d.ts",
  ],
  "@openclaw/discord/api.js": ["../.artifacts/extension-package-boundary/plugins/discord/api.d.ts"],
  "@openclaw/slack/test-api.js": [
    "../.artifacts/extension-package-boundary/plugins/slack/test-api.d.ts",
  ],
  "@openclaw/telegram/api.js": [
    "../.artifacts/extension-package-boundary/plugins/telegram/api.d.ts",
  ],
  "@openclaw/whatsapp/api.js": [
    "../.artifacts/extension-package-boundary/plugins/whatsapp/api.d.ts",
  ],
} as const;

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: Record<string, string[]>;
    rootDir?: unknown;
    outDir?: unknown;
    declaration?: unknown;
    emitDeclarationOnly?: unknown;
  };
  include?: unknown;
  exclude?: unknown;
};

type PackageJson = {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  type?: unknown;
  exports?: Record<string, { types?: unknown; default?: unknown }>;
  devDependencies?: Record<string, string>;
};
const MEMORY_HOST_SDK_EXPORTS = (
  "engine-embeddings engine-foundation engine-sessions engine-storage multimodal query " +
  "runtime-core runtime-files secret status"
)
  .split(" ")
  .map((name) => `./${name}`);
const MEMORY_HOST_SDK_ALLOWED_CORE_BRIDGE_FILES = [
  "embeddings.types",
  "error-utils",
  ..."agent auth config io kysely memory network paths session sqlite workspace"
    .split(" ")
    .map((name) => `openclaw-runtime-${name}`),
  // Standalone transcript readers use narrow core read owners.
  "session-entry-render",
  "session-reset-recall-read.worker",
  "session-transcript-corpus.worker",
].map((name) => `packages/memory-host-sdk/src/host/${name}.ts`);

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe JSON file shape.
function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

function readExtensionTsconfig(extensionName: string): TsConfigJson {
  return readJsonFile<TsConfigJson>(`extensions/${extensionName}/tsconfig.json`);
}

function isContainedPackageBoundaryTarget(target: string): boolean {
  const root = /^\.\.\/(dist|packages|extensions|\.artifacts\/extension-package-boundary)\//u.exec(
    target,
  )?.[1];
  return root !== undefined && posix.normalize(target).startsWith(`../${root}/`);
}

function collectExtensionsWithTsconfig(): string[] {
  return fs
    .readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(resolve(REPO_ROOT, "extensions", entry.name, "tsconfig.json")),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function collectCodeFiles(relativeDir: string): string[] {
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeDir });
  expect(trackedFiles, "package boundary scans require a Git checkout").not.toBeNull();
  return (trackedFiles ?? [])
    .filter((line) => line.length > 0 && /\.(?:[cm]?ts|tsx|mts|cts)$/u.test(line))
    .filter((line) => fs.existsSync(resolve(REPO_ROOT, line)))
    .toSorted();
}

function collectCoreReferenceFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir)
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("../../../../src/") || source.includes("../../../src/");
    });
}

function collectCombinedRuntimeImportFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir).filter((file) => {
    const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
    return /["'][^"']*\/openclaw-runtime\.[cm]?[jt]s["']/u.test(source);
  });
}

describe("opt-in extension package boundaries", () => {
  it("lists package boundary code files from git without walking package roots", () => {
    expectNoReaddirSyncDuring(() => {
      const memoryHostFiles = collectCodeFiles("packages/memory-host-sdk/src");
      const packageContractFiles = collectCodeFiles("packages/plugin-package-contract/src");

      expect(memoryHostFiles.length).toBeGreaterThan(0);
      expect(packageContractFiles.length).toBeGreaterThan(0);
    });
  });

  it("keeps package boundaries and path aliases in shared configs", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG);
    expect(pathsConfig.extends).toBe("../tsconfig.json");
    const paths = pathsConfig.compilerOptions?.paths;
    expect(paths).toBeDefined();
    if (!paths) {
      throw new Error("Missing shared extension package boundary aliases");
    }
    expect(paths["openclaw/plugin-sdk/*"]).toEqual([
      "../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts",
    ]);
    for (const [specifier, targets] of Object.entries(XAI_OMITTED_BOUNDARY_PATHS)) {
      expect(paths[specifier], specifier).toEqual(targets);
    }
    for (const entrypoint of privateLocalOnlyPluginSdkEntrypoints) {
      expect(paths[`openclaw/plugin-sdk/${entrypoint}`], entrypoint).toEqual([
        `../packages/plugin-sdk/dist/src/plugin-sdk/${entrypoint}.d.ts`,
      ]);
    }
    const acpPackage = readJsonFile<{
      exports: Record<string, string | { import?: string }>;
    }>("packages/acp-core/package.json");
    for (const [exportKey, value] of Object.entries(acpPackage.exports)) {
      const importPath = typeof value === "string" ? value : value.import;
      if (!importPath?.startsWith("./dist/") || !importPath.endsWith(".mjs")) {
        continue;
      }
      const subpath = exportKey === "." ? "" : exportKey.slice(2);
      const specifier = subpath ? `@openclaw/acp-core/${subpath}` : "@openclaw/acp-core";
      expect(paths[specifier], specifier).toEqual([
        `../packages/plugin-sdk/dist/packages/acp-core/src/${subpath || "index"}.d.ts`,
      ]);
    }
    for (const [specifier, targets] of Object.entries(paths)) {
      expect(targets.length, specifier).toBeGreaterThan(0);
      for (const target of targets) {
        expect(isContainedPackageBoundaryTarget(target), specifier).toBe(true);
      }
    }

    const baseConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG);
    expect(baseConfig.extends).toBe("./tsconfig.package-boundary.paths.json");
    expect(baseConfig.compilerOptions).toEqual({
      ignoreDeprecations: "6.0",
      rootDir: "${configDir}",
    });
    expect(baseConfig.include).toEqual(["${configDir}/*.ts", "${configDir}/src/**/*.ts"]);
    expect(baseConfig.exclude).toEqual([
      "${configDir}/**/*.test.ts",
      "${configDir}/dist/**",
      "${configDir}/node_modules/**",
      "${configDir}/src/test-support/**",
      "${configDir}/src/**/*test-helpers.ts",
      "${configDir}/src/**/*test-harness.ts",
      "${configDir}/src/**/*test-support.ts",
    ]);
  });

  it("rejects package aliases that escape their declared declaration root", () => {
    for (const target of [
      "../dist/../src/gateway/auth.ts",
      "../packages/../../src/gateway/auth.ts",
      "../extensions/../src/gateway/auth.ts",
    ]) {
      expect(isContainedPackageBoundaryTarget(target), target).toBe(false);
    }
  });

  it("keeps every opt-in extension rooted inside its package and on the package sdk", () => {
    for (const extensionName of collectExtensionsWithTsconfig()) {
      const tsconfig = readExtensionTsconfig(extensionName);
      expect(tsconfig.extends, extensionName).toBe("../tsconfig.package-boundary.base.json");
      expect(tsconfig.compilerOptions?.rootDir).toBeUndefined();
      expect(tsconfig.include).toBeUndefined();
      expect(tsconfig.exclude).toBeUndefined();

      const packageJson = readJsonFile<PackageJson>(`extensions/${extensionName}/package.json`);
      expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
    }
  });

  it("keeps xai as the only opt-in extension with custom path overrides", () => {
    const extensionsWithCustomPaths = collectExtensionsWithTsconfig().filter((extensionName) => {
      const tsconfig = readExtensionTsconfig(extensionName);
      return tsconfig.compilerOptions?.paths !== undefined;
    });

    expect(extensionsWithCustomPaths).toEqual(["xai"]);
  });

  it("keeps xai's boundary-specific path overrides derived from the shared package boundary map", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG);
    const paths = pathsConfig.compilerOptions?.paths;
    if (!paths) {
      throw new Error("Missing shared extension package boundary aliases");
    }
    const omitted = new Set(Object.keys(XAI_OMITTED_BOUNDARY_PATHS));
    const expectedPaths = Object.fromEntries(
      Object.entries(paths)
        .filter(([specifier]) => !omitted.has(specifier))
        .map(([specifier, targets]) => [
          specifier,
          targets.map((target) => posix.join("../", target)),
        ]),
    );
    Object.assign(expectedPaths, {
      "@openclaw/qa-channel/api.js": [
        "../../.artifacts/extension-package-boundary/plugins/qa-channel/api.d.ts",
      ],
      "@openclaw/*.js": ["../../packages/plugin-sdk/dist/extensions/*.d.ts", "../*"],
      "@openclaw/*": ["../*"],
      "@openclaw/plugin-sdk/*": ["../../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts"],
      "@openclaw/anthropic-vertex/api.js": ["./.boundary-stubs/anthropic-vertex-api.d.ts"],
      "@openclaw/ollama/api.js": ["./.boundary-stubs/ollama-api.d.ts"],
      "@openclaw/ollama/runtime-api.js": ["./.boundary-stubs/ollama-runtime-api.d.ts"],
    });
    expect(readExtensionTsconfig("xai").compilerOptions?.paths).toEqual(expectedPaths);
  });

  it("keeps plugin-sdk package types generated from the package build, not a hand-maintained types bridge", () => {
    const tsconfig = readJsonFile<TsConfigJson>("packages/plugin-sdk/tsconfig.json");
    expect(tsconfig).toMatchObject({
      extends: "../../tsconfig.json",
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "dist",
        rootDir: "../..",
      },
    });
    expect(tsconfig.include).toEqual(
      expect.arrayContaining(["../../src/plugin-sdk/**/*.ts", "../../src/types/**/*.d.ts"]),
    );

    const packageJson = readJsonFile<PackageJson>("packages/plugin-sdk/package.json");
    expect(packageJson.name).toBe("@openclaw/plugin-sdk");
    for (const entry of (
      "account-id acp-runtime cli-runtime core error-runtime exec-approvals-runtime " +
      "plugin-entry plugin-runtime provider-env-vars provider-http provider-usage " +
      "provider-web-search-contract provider-web-search-config-contract runtime-env " +
      "security-runtime secret-ref-runtime ssrf-runtime config-contracts text-utility-runtime " +
      "video-generation provider-model-types system-event-runtime"
    ).split(" ")) {
      expect(packageJson.exports?.[`./${entry}`]?.types, entry).toBe(
        `./dist/src/plugin-sdk/${entry}.d.ts`,
      );
    }
    expect(fs.existsSync(resolve(REPO_ROOT, "packages/plugin-sdk/types/plugin-entry.d.ts"))).toBe(
      false,
    );
  });

  it("keeps memory-host-sdk as a private package-owned contract surface", () => {
    const packageJson = readJsonFile<PackageJson>("packages/memory-host-sdk/package.json");
    const packageExports = packageJson.exports as unknown as Record<string, string>;

    expect(packageJson).toMatchObject({
      name: "@openclaw/memory-host-sdk",
      version: "0.0.0-private",
      private: true,
      type: "module",
    });
    expect(Object.keys(packageExports).toSorted()).toEqual([...MEMORY_HOST_SDK_EXPORTS]);

    for (const exportPath of MEMORY_HOST_SDK_EXPORTS) {
      const target = packageExports[exportPath];
      expect(target, exportPath).toBe(`./src/${exportPath.slice(2)}.ts`);
      if (!target) {
        throw new Error(`Missing memory-host-sdk export target for ${exportPath}`);
      }
      const source = fs.readFileSync(
        resolve(REPO_ROOT, "packages/memory-host-sdk", target),
        "utf8",
      );
      expect(source, target).not.toContain("src/memory-host-sdk/");
    }

    expect(collectCoreReferenceFiles("packages/memory-host-sdk/src")).toEqual([
      ...MEMORY_HOST_SDK_ALLOWED_CORE_BRIDGE_FILES,
    ]);
    expect(collectCombinedRuntimeImportFiles("packages/memory-host-sdk/src")).toEqual([]);
    expect(
      fs.existsSync(resolve(REPO_ROOT, "packages/memory-host-sdk/src/host/openclaw-runtime.ts")),
    ).toBe(false);
  });

  it("keeps memory config values independent from config IO and runtime facades", () => {
    const source = fs.readFileSync(
      resolve(REPO_ROOT, "packages/memory-host-sdk/src/host/openclaw-runtime-config.ts"),
      "utf8",
    );
    const sources = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map(
      (match) => match[1] ?? "",
    );

    // This facade is used by embedding metadata. Every dependency must remain a
    // config value/shape owner; config loading belongs to the session runtime.
    expect([...new Set(sources)].toSorted()).toEqual([
      "../../../../src/cli/parse-duration.js",
      "../../../../src/config/byte-size.js",
      "../../../../src/config/paths.js",
      "../../../../src/config/sessions/paths.js",
      "../../../../src/config/types.memory.js",
      "../../../../src/config/types.openclaw.js",
      "../../../../src/config/types.secrets.js",
      "../../../../src/config/types.tools.js",
    ]);
    expect(source).not.toMatch(/^\s*import\b/mu);
  });

  it("keeps plugin-package-contract independent from core internals", () => {
    expect(collectCoreReferenceFiles("packages/plugin-package-contract/src")).toStrictEqual([]);
  });
});
