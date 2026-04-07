import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExtensionsWithTsconfig,
  collectOptInExtensionPackageBoundaries,
  EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS,
  EXTENSION_PACKAGE_BOUNDARY_EXCLUDE,
  EXTENSION_PACKAGE_BOUNDARY_INCLUDE,
  isOptInExtensionPackageBoundaryTsconfig,
  readExtensionPackageBoundaryPackageJson,
  readExtensionPackageBoundaryTsconfig,
} from "../../../scripts/lib/extension-package-boundary.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG =
  "extensions/tsconfig.package-boundary.paths.json" as const;
const EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG =
  "extensions/tsconfig.package-boundary.base.json" as const;

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: unknown;
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
  exports?: Record<string, { types?: unknown; default?: unknown }>;
  devDependencies?: Record<string, string>;
};

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

describe("opt-in extension package boundaries", () => {
  it("keeps path aliases in a dedicated shared config", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG);
    expect(pathsConfig.extends).toBe("../tsconfig.json");
    expect(pathsConfig.compilerOptions?.paths).toEqual(EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS);

    const baseConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG);
    expect(baseConfig.extends).toBe("./tsconfig.package-boundary.paths.json");
    expect(baseConfig.compilerOptions).toEqual({
      ignoreDeprecations: "6.0",
    });
  });

  it("keeps every opt-in extension rooted inside its package and on the package sdk", () => {
    const extensionsWithTsconfig = collectExtensionsWithTsconfig(REPO_ROOT);
    const optInExtensions = collectOptInExtensionPackageBoundaries(REPO_ROOT);

    expect(extensionsWithTsconfig).toEqual(optInExtensions);

    for (const extensionName of optInExtensions) {
      const tsconfig = readExtensionPackageBoundaryTsconfig(extensionName, REPO_ROOT);
      expect(isOptInExtensionPackageBoundaryTsconfig(tsconfig)).toBe(true);
      expect(tsconfig.compilerOptions?.rootDir).toBe(".");
      expect(tsconfig.include).toEqual([...EXTENSION_PACKAGE_BOUNDARY_INCLUDE]);
      expect(tsconfig.exclude).toEqual([...EXTENSION_PACKAGE_BOUNDARY_EXCLUDE]);

      const packageJson = readExtensionPackageBoundaryPackageJson(extensionName, REPO_ROOT);
      expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
    }
  });

  it("keeps plugin-sdk package types generated from the package build, not a hand-maintained types bridge", () => {
    const tsconfig = readJsonFile<TsConfigJson>("packages/plugin-sdk/tsconfig.json");
    expect(tsconfig.extends).toBe("../../tsconfig.json");
    expect(tsconfig.compilerOptions?.declaration).toBe(true);
    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBe(true);
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.compilerOptions?.rootDir).toBe("../..");
    expect(tsconfig.include).toEqual([
      "../../src/plugin-sdk/config-runtime.ts",
      "../../src/plugin-sdk/index.ts",
      "../../src/plugin-sdk/lazy-value.ts",
      "../../src/plugin-sdk/oauth-utils.ts",
      "../../src/plugin-sdk/plugin-entry.ts",
      "../../src/plugin-sdk/plugin-runtime.ts",
      "../../src/plugin-sdk/provider-auth-result.ts",
      "../../src/plugin-sdk/provider-auth-runtime.ts",
      "../../src/plugin-sdk/provider-auth.ts",
      "../../src/plugin-sdk/provider-catalog-shared.ts",
      "../../src/plugin-sdk/provider-entry.ts",
      "../../src/plugin-sdk/provider-http.ts",
      "../../src/plugin-sdk/provider-model-shared.ts",
      "../../src/plugin-sdk/provider-onboard.ts",
      "../../src/plugin-sdk/provider-stream-shared.ts",
      "../../src/plugin-sdk/provider-tools.ts",
      "../../src/plugin-sdk/provider-web-search.ts",
      "../../src/plugin-sdk/runtime-doctor.ts",
      "../../src/plugin-sdk/runtime-env.ts",
      "../../src/plugin-sdk/security-runtime.ts",
      "../../src/plugin-sdk/secret-input-schema.ts",
      "../../src/plugin-sdk/secret-input.ts",
      "../../src/plugin-sdk/telegram-command-config.ts",
      "../../src/plugin-sdk/testing.ts",
      "../../src/plugin-sdk/text-runtime.ts",
      "../../src/plugin-sdk/video-generation.ts",
      "../../src/video-generation/dashscope-compatible.ts",
      "../../src/video-generation/types.ts",
      "../../src/types/**/*.d.ts",
    ]);

    const packageJson = readJsonFile<PackageJson>("packages/plugin-sdk/package.json");
    expect(packageJson.name).toBe("@openclaw/plugin-sdk");
    expect(packageJson.exports?.["./core"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-entry"]?.types).toBe(
      "./dist/src/plugin-sdk/plugin-entry.d.ts",
    );
    expect(packageJson.exports?.["./plugin-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/plugin-runtime.d.ts",
    );
    expect(packageJson.exports?.["./provider-http"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-http.d.ts",
    );
    expect(packageJson.exports?.["./runtime-doctor"]?.types).toBe(
      "./dist/src/plugin-sdk/runtime-doctor.d.ts",
    );
    expect(packageJson.exports?.["./security-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/security-runtime.d.ts",
    );
    expect(packageJson.exports?.["./text-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/text-runtime.d.ts",
    );
    expect(packageJson.exports?.["./video-generation"]?.types).toBe(
      "./dist/src/plugin-sdk/video-generation.d.ts",
    );
    expect(existsSync(resolve(REPO_ROOT, "packages/plugin-sdk/types/plugin-entry.d.ts"))).toBe(
      false,
    );
  });
});
