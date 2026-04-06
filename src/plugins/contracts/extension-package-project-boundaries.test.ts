import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

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
  it("keeps the opt-in extension base on real package resolution", () => {
    const tsconfig = readJsonFile<TsConfigJson>("extensions/tsconfig.package-boundary.base.json");
    expect(tsconfig.extends).toBe("../tsconfig.json");
    expect(tsconfig.compilerOptions?.paths).toEqual({
      "openclaw/extension-api": ["../src/extensionAPI.ts"],
      "openclaw/plugin-sdk": ["../src/plugin-sdk/index.ts"],
      "openclaw/plugin-sdk/*": ["../src/plugin-sdk/*.ts"],
      "openclaw/plugin-sdk/account-id": ["../src/plugin-sdk/account-id.ts"],
      "@openclaw/*": ["../extensions/*"],
      "@openclaw/plugin-sdk/*": ["../packages/plugin-sdk/dist/packages/plugin-sdk/src/*.d.ts"],
    });
  });

  it("roots xai inside its own package and depends on the package sdk", () => {
    const tsconfig = readJsonFile<TsConfigJson>("extensions/xai/tsconfig.json");
    expect(tsconfig.extends).toBe("../tsconfig.package-boundary.base.json");
    expect(tsconfig.compilerOptions?.rootDir).toBe(".");
    expect(tsconfig.include).toEqual(["./*.ts", "./src/**/*.ts"]);
    expect(tsconfig.exclude).toEqual(["./**/*.test.ts", "./dist/**", "./node_modules/**"]);

    const packageJson = readJsonFile<PackageJson>("extensions/xai/package.json");
    expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
  });

  it("keeps plugin-sdk package types generated from the package build, not a hand-maintained types bridge", () => {
    const tsconfig = readJsonFile<TsConfigJson>("packages/plugin-sdk/tsconfig.json");
    expect(tsconfig.extends).toBe("../../tsconfig.json");
    expect(tsconfig.compilerOptions?.declaration).toBe(true);
    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBe(true);
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.compilerOptions?.rootDir).toBe("../..");
    expect(tsconfig.include).toEqual([
      "src/**/*.ts",
      "../../src/types/**/*.d.ts",
      "../../packages/memory-host-sdk/src/**/*.ts",
    ]);

    const packageJson = readJsonFile<PackageJson>("packages/plugin-sdk/package.json");
    expect(packageJson.name).toBe("@openclaw/plugin-sdk");
    expect(packageJson.exports?.["./core"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-entry"]?.types).toBe(
      "./dist/packages/plugin-sdk/src/plugin-entry.d.ts",
    );
    expect(packageJson.exports?.["./provider-http"]?.types).toBe(
      "./dist/packages/plugin-sdk/src/provider-http.d.ts",
    );
    expect(packageJson.exports?.["./video-generation"]?.types).toBe(
      "./dist/packages/plugin-sdk/src/video-generation.d.ts",
    );
    expect(existsSync(resolve(REPO_ROOT, "packages/plugin-sdk/types/plugin-entry.d.ts"))).toBe(
      false,
    );
  });
});
