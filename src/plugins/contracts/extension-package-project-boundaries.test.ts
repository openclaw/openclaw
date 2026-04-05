import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    rootDir?: unknown;
    paths?: Record<string, unknown>;
  };
  include?: unknown;
  exclude?: unknown;
};

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

function listBundledPluginRoots(): string[] {
  return readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(resolve(REPO_ROOT, "extensions", name, "package.json"), "utf8");
        return true;
      } catch {
        return false;
      }
    })
    .toSorted()
    .map((name) => `extensions/${name}`);
}

function expectLocalProjectPatterns(projectPath: string, fieldName: "include" | "exclude") {
  const tsconfig = readJsonFile<TsConfigJson>(projectPath);
  const raw = tsconfig[fieldName];
  expect(Array.isArray(raw), `${projectPath} ${fieldName} must be an array`).toBe(true);
  const patterns = raw as unknown[];
  expect(patterns.length, `${projectPath} ${fieldName} must not be empty`).toBeGreaterThan(0);
  expect(
    patterns.every((value) => typeof value === "string"),
    `${projectPath} ${fieldName} entries must be strings`,
  ).toBe(true);
  expect(
    (patterns as string[]).every((value) => !value.includes("../")),
    `${projectPath} ${fieldName} must stay package-local`,
  ).toBe(true);
}

describe("extension package TypeScript boundaries", () => {
  it("keeps the extension base config on emitted SDK declarations", () => {
    const extensionBaseTsconfig = readJsonFile<TsConfigJson>("extensions/tsconfig.base.json");
    expect(extensionBaseTsconfig.extends).toBe("../tsconfig.json");
    expect(extensionBaseTsconfig.compilerOptions?.paths).toEqual({
      "openclaw/plugin-sdk": ["dist/plugin-sdk/src/plugin-sdk/index.d.ts"],
      "openclaw/plugin-sdk/*": ["dist/plugin-sdk/src/plugin-sdk/*.d.ts"],
      "@openclaw/*": ["dist/plugin-sdk/extensions/*"],
    });
  });

  it("gives every bundled plugin package a local tsconfig rooted in that package", () => {
    for (const packageRoot of listBundledPluginRoots()) {
      const tsconfigPath = `${packageRoot}/tsconfig.json`;
      const tsconfig = readJsonFile<TsConfigJson>(tsconfigPath);
      expect(tsconfig.extends, `${tsconfigPath} must inherit the extension base`).toBe(
        "../tsconfig.base.json",
      );
      expect(
        tsconfig.compilerOptions?.rootDir,
        `${tsconfigPath} must enforce package rootDir`,
      ).toBe(".");
      expectLocalProjectPatterns(tsconfigPath, "include");
      expectLocalProjectPatterns(tsconfigPath, "exclude");
    }
  });
});
