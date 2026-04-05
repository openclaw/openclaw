import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: unknown;
    rootDir?: unknown;
  };
  include?: unknown;
  exclude?: unknown;
};

type PackageJson = {
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
      "@openclaw/plugin-sdk/*": ["packages/plugin-sdk/types/*.d.ts"],
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
});
