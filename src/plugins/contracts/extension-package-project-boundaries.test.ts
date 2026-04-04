import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: Record<string, unknown>;
  };
  include?: unknown;
  exclude?: unknown;
};

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

function listWorkspacePackageRoots(parentDir: string): string[] {
  const absoluteParentDir = resolve(REPO_ROOT, parentDir);
  return readdirSync(absoluteParentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(resolve(absoluteParentDir, name, "package.json"), "utf8");
        return true;
      } catch {
        return false;
      }
    })
    .toSorted()
    .map((name) => `${parentDir}/${name}`);
}

function readTsConfig(relativePath: string): TsConfigJson {
  return readJsonFile<TsConfigJson>(relativePath);
}

function expectLocalProjectPatterns(projectPath: string, fieldName: "include" | "exclude") {
  const tsconfig = readTsConfig(projectPath);
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

describe("workspace-local TypeScript project boundaries", () => {
  it("keeps the root openclaw project narrowed to src", () => {
    const rootTsconfig = readTsConfig("tsconfig.json");
    expect(rootTsconfig.extends).toBe("./tsconfig.base.json");
    expect(rootTsconfig.include).toEqual(["src/**/*"]);
    expect(rootTsconfig.exclude).toEqual(["node_modules", "dist"]);
  });

  it("keeps the workspace solution broad and separate from the root package project", () => {
    const workspaceTsconfig = readTsConfig("tsconfig.workspace.json");
    expect(workspaceTsconfig.extends).toBe("./tsconfig.json");
    expect(workspaceTsconfig.include).toEqual([
      "src/**/*",
      "ui/**/*",
      "extensions/**/*",
      "packages/**/*",
    ]);
    expect(workspaceTsconfig.exclude).toEqual(["node_modules", "dist"]);
  });

  it("keeps the extension base config limited to plugin-sdk paths", () => {
    const extensionBaseTsconfig = readTsConfig("extensions/tsconfig.base.json");
    expect(extensionBaseTsconfig.extends).toBe("../tsconfig.base.json");
    expect(extensionBaseTsconfig.compilerOptions?.paths).toEqual({
      "openclaw/plugin-sdk": ["src/plugin-sdk/index.ts"],
      "openclaw/plugin-sdk/*": ["src/plugin-sdk/*.ts"],
    });
  });

  it("gives every bundled plugin package a local tsconfig rooted in that package", () => {
    for (const packageRoot of listWorkspacePackageRoots("extensions")) {
      const tsconfigPath = `${packageRoot}/tsconfig.json`;
      const tsconfig = readTsConfig(tsconfigPath);
      expect(tsconfig.extends, `${tsconfigPath} must inherit the extension base`).toBe(
        "../tsconfig.base.json",
      );
      expectLocalProjectPatterns(tsconfigPath, "include");
      expectLocalProjectPatterns(tsconfigPath, "exclude");
    }
  });

  it("gives every workspace package its own local tsconfig", () => {
    for (const packageRoot of listWorkspacePackageRoots("packages")) {
      const tsconfigPath = `${packageRoot}/tsconfig.json`;
      const tsconfig = readTsConfig(tsconfigPath);
      expect(tsconfig.extends, `${tsconfigPath} must inherit the package base`).toBe(
        "../tsconfig.base.json",
      );
      expectLocalProjectPatterns(tsconfigPath, "include");
      expectLocalProjectPatterns(tsconfigPath, "exclude");
    }
  });

  it("gives ui its own TypeScript project", () => {
    const uiTsconfig = readTsConfig("ui/tsconfig.json");
    expect(uiTsconfig.extends).toBe("../tsconfig.base.json");
    expect(Array.isArray(uiTsconfig.include)).toBe(true);
    expect(Array.isArray(uiTsconfig.exclude)).toBe(true);
  });
});
