import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isJavaScriptModulePath,
  resolveCompiledBundledModulePath,
  resolveExistingPluginModulePath,
  resolvePluginModuleCandidates,
} from "./module-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-module-loader-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("channel plugin module loader helpers", () => {
  it("prefers compiled bundled dist output when present", () => {
    const rootDir = createTempDir();
    const runtimePath = path.join(rootDir, "dist-runtime", "entry.js");
    const compiledPath = path.join(rootDir, "dist", "entry.js");
    fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
    fs.writeFileSync(compiledPath, "export {};\n", "utf8");

    expect(resolveCompiledBundledModulePath(runtimePath)).toBe(compiledPath);
  });

  it("keeps dist-runtime path when compiled bundled output is absent", () => {
    const rootDir = createTempDir();
    const runtimePath = path.join(rootDir, "dist-runtime", "entry.js");

    expect(resolveCompiledBundledModulePath(runtimePath)).toBe(runtimePath);
  });

  it("resolves plugin module candidates and picks the first existing extension", () => {
    const rootDir = createTempDir();
    const expectedPath = path.join(rootDir, "src", "checker.mjs");
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, "export const ok = true;\n", "utf8");

    expect(resolvePluginModuleCandidates(rootDir, "./src/checker")).toEqual([
      path.join(rootDir, "src", "checker"),
      path.join(rootDir, "src", "checker.ts"),
      path.join(rootDir, "src", "checker.js"),
      path.join(rootDir, "src", "checker.mjs"),
      path.join(rootDir, "src", "checker.cjs"),
    ]);
    expect(resolveExistingPluginModulePath(rootDir, "./src/checker")).toBe(expectedPath);
  });

  it("detects JavaScript module paths case-insensitively", () => {
    expect(isJavaScriptModulePath("/tmp/entry.js")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.MJS")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.ts")).toBe(false);
  });
});
