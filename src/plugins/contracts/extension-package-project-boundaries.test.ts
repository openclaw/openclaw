import fs from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../../scripts/lib/plugin-sdk-entries.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PATHS_CONFIG = "extensions/tsconfig.package-boundary.paths.json";
const BASE_CONFIG = "extensions/tsconfig.package-boundary.base.json";
const XAI_OMITTED_BOUNDARY_PATHS = {
  "openclaw/plugin-sdk/browser-maintenance": [
    "../packages/plugin-sdk/dist/extensions/browser/browser-maintenance.d.ts",
  ],
  ...Object.fromEntries(
    ["channel-secret-owner-runtime", "channel-secret-tts-runtime"].map((name) => [
      `openclaw/plugin-sdk/${name}`,
      [`../packages/plugin-sdk/dist/src/plugin-sdk/${name}.d.ts`],
    ]),
  ),
  ...Object.fromEntries(
    ["matrix/test-api", "discord/api", "slack/test-api", "telegram/api", "whatsapp/api"].map(
      (name) => [
        `@openclaw/${name}.js`,
        [`../.artifacts/extension-package-boundary/plugins/${name}.d.ts`],
      ],
    ),
  ),
};

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: Record<string, string[]>;
    rootDir?: unknown;
  };
  include?: unknown;
  exclude?: unknown;
};

type PackageJson = {
  name?: unknown;
  exports?: Record<string, { types?: unknown; default?: unknown }>;
  devDependencies?: Record<string, string>;
};
const MEMORY_HOST_SDK_EXPORTS = (
  "engine-embeddings engine-foundation engine-sessions engine-storage multimodal query " +
  "runtime-core runtime-files secret status"
)
  .split(" ")
  .map((name) => `./${name}`);
const MEMORY_CORE_BRIDGES = [
  "embeddings.types",
  "error-utils",
  ..."agent auth config io kysely memory network paths session sqlite workspace"
    .split(" ")
    .map((name) => `openclaw-runtime-${name}`),
  // Per-call deadlines and standalone transcript readers use narrow core owners.
  ...(
    "search-deadline-control session-entry-render session-memory-authority " +
    "session-reset-recall-read.worker session-transcript-corpus.worker session-transcript-stats-read"
  ).split(" "),
].map((name) => `packages/memory-host-sdk/src/host/${name}.ts`);

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe JSON file shape.
function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readSource(relativePath)) as T;
}

function readSource(relativePath: string): string {
  return fs.readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
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
  return (trackedFiles ?? []).filter((line) => /\.(?:[cm]?ts|tsx|mts|cts)$/u.test(line));
}

function collectCoreReferenceFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir).filter(
    (file) => !file.endsWith(".test.ts") && readSource(file).includes("../../../src/"),
  );
}

function collectCombinedRuntimeImportFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir).filter((file) =>
    /["'][^"']*\/openclaw-runtime\.[cm]?[jt]s["']/u.test(readSource(file)),
  );
}

describe("opt-in extension package boundaries", () => {
  it("keeps package boundaries and path aliases in shared configs", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(PATHS_CONFIG);
    expect(pathsConfig.extends).toBe("../tsconfig.json");
    const paths = pathsConfig.compilerOptions?.paths;
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

    const baseConfig = readJsonFile<TsConfigJson>(BASE_CONFIG);
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
      if (extensionName !== "xai") {
        expect(tsconfig.compilerOptions?.paths, extensionName).toBeUndefined();
      }

      const packageJson = readJsonFile<PackageJson>(`extensions/${extensionName}/package.json`);
      expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
    }
  });

  it("keeps xai's boundary-specific path overrides derived from the shared package boundary map", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(PATHS_CONFIG);
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
    expectNoReaddirSyncDuring(() => {
      expect(collectCodeFiles("packages/memory-host-sdk/src").length).toBeGreaterThan(0);
    });
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
      const source = readSource(`packages/memory-host-sdk/${target}`);
      expect(source, target).not.toContain("src/memory-host-sdk/");
    }

    expect(collectCoreReferenceFiles("packages/memory-host-sdk/src")).toEqual(MEMORY_CORE_BRIDGES);
    expect(collectCombinedRuntimeImportFiles("packages/memory-host-sdk/src")).toEqual([]);
    expect(
      fs.existsSync(resolve(REPO_ROOT, "packages/memory-host-sdk/src/host/openclaw-runtime.ts")),
    ).toBe(false);
  });

  it("keeps memory config values independent from config IO and runtime facades", () => {
    const source = readSource("packages/memory-host-sdk/src/host/openclaw-runtime-config.ts");
    const sources = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map(
      (match) => match[1] ?? "",
    );

    // This facade is used by embedding metadata. Every dependency must remain a
    // config value/shape owner; config loading belongs to the session runtime.
    expect([...new Set(sources)].toSorted()).toEqual(
      (
        "cli/parse-duration config/byte-size config/paths config/sessions/paths " +
        "config/types.memory config/types.openclaw config/types.secrets config/types.tools"
      )
        .split(" ")
        .map((file) => `../../../../src/${file}.js`),
    );
    expect(source).not.toMatch(/^\s*import\b/mu);
  });

  it("keeps plugin-package-contract independent from core internals", () => {
    expectNoReaddirSyncDuring(() => {
      expect(collectCodeFiles("packages/plugin-package-contract/src").length).toBeGreaterThan(0);
    });
    expect(collectCoreReferenceFiles("packages/plugin-package-contract/src")).toStrictEqual([]);
  });
});
