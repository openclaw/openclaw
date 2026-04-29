import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBundledRuntimeDependencyJitiAliases,
  registerBundledRuntimeDependencyJitiAliases,
  resolveBundledRuntimeDependencyJitiAliasMap,
} from "./bundled-runtime-deps-jiti-aliases.js";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-aliases-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "export default null;\n", "utf8");
}

function packageRoot(rootDir: string, packageName: string): string {
  return path.join(rootDir, "node_modules", ...packageName.split("/"));
}

afterEach(() => {
  clearBundledRuntimeDependencyJitiAliases();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("bundled runtime dependency Jiti aliases", () => {
  it("registers root, subpath, wildcard, and scoped package aliases", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        plain: "1.0.0",
        wild: "1.0.0",
        "@scope/pkg": "1.0.0",
      },
    });

    const plainRoot = packageRoot(rootDir, "plain");
    writeJson(path.join(plainRoot, "package.json"), {
      exports: {
        ".": { import: "./esm/index.js", default: "./cjs/index.js" },
        "./feature": "./features/feature.js",
      },
    });
    writeFile(path.join(plainRoot, "esm/index.js"));
    writeFile(path.join(plainRoot, "features/feature.js"));

    const wildRoot = packageRoot(rootDir, "wild");
    writeJson(path.join(wildRoot, "package.json"), {
      exports: {
        "./sub/*": "./dist/*.js",
      },
    });
    writeFile(path.join(wildRoot, "dist/a.js"));
    writeFile(path.join(wildRoot, "dist/nested/b.js"));

    const scopedRoot = packageRoot(rootDir, "@scope/pkg");
    writeJson(path.join(scopedRoot, "package.json"), {
      module: "./index.mjs",
    });
    writeFile(path.join(scopedRoot, "index.mjs"));

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toEqual({
      "wild/sub/nested/b": path.join(wildRoot, "dist/nested/b.js"),
      "plain/feature": path.join(plainRoot, "features/feature.js"),
      "@scope/pkg": path.join(scopedRoot, "index.mjs"),
      "wild/sub/a": path.join(wildRoot, "dist/a.js"),
      plain: path.join(plainRoot, "esm/index.js"),
    });
  });

  it("ignores missing, private, and escaping export targets", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        unsafe: "1.0.0",
      },
    });
    const unsafeRoot = packageRoot(rootDir, "unsafe");
    writeJson(path.join(unsafeRoot, "package.json"), {
      exports: {
        ".": "../outside.js",
        "./private": "#internal",
        "./missing": "./missing.js",
      },
    });

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toBeUndefined();
  });
});
