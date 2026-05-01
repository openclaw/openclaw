import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isJavaScriptModulePath,
  loadChannelPluginModule,
  resolveCompiledBundledModulePath,
  resolveExistingPluginModulePath,
  resolvePluginModuleCandidates,
  resetChannelPluginModuleLoaderStateForTest,
  setChannelPluginModuleLoaderJitiFactoryForTest,
} from "./module-loader.js";

const tempDirs: string[] = [];
type ChannelModuleLoaderJitiFactory = NonNullable<
  Parameters<typeof setChannelPluginModuleLoaderJitiFactoryForTest>[0]
>;

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("jiti");
  resetChannelPluginModuleLoaderStateForTest();
  setChannelPluginModuleLoaderJitiFactoryForTest(undefined);
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
    const expectedPath = path.join(rootDir, "src", "checker.mts");
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, "export const ok = true;\n", "utf8");

    expect(resolvePluginModuleCandidates(rootDir, "./src/checker")).toEqual([
      path.join(rootDir, "src", "checker"),
      path.join(rootDir, "src", "checker.ts"),
      path.join(rootDir, "src", "checker.mts"),
      path.join(rootDir, "src", "checker.js"),
      path.join(rootDir, "src", "checker.mjs"),
      path.join(rootDir, "src", "checker.cts"),
      path.join(rootDir, "src", "checker.cjs"),
    ]);
    expect(resolveExistingPluginModulePath(rootDir, "./src/checker")).toBe(expectedPath);
  });

  it("detects JavaScript module paths case-insensitively", () => {
    expect(isJavaScriptModulePath("/tmp/entry.js")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.MJS")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.ts")).toBe(false);
  });

  it("uses native require for eligible JavaScript modules before falling back to Jiti", () => {
    const createJiti = vi.fn(
      () => vi.fn(() => ({ ok: false })) as unknown as ReturnType<ChannelModuleLoaderJitiFactory>,
    );
    resetChannelPluginModuleLoaderStateForTest();
    setChannelPluginModuleLoaderJitiFactoryForTest(
      createJiti as unknown as ChannelModuleLoaderJitiFactory,
    );
    const rootDir = createTempDir();
    const modulePath = path.join(rootDir, "dist", "extensions", "demo", "index.cjs");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "module.exports = { ok: true };\n", "utf8");

    expect(
      loadChannelPluginModule({
        modulePath,
        rootDir,
        shouldTryNativeRequire: () => true,
      }),
    ).toEqual({ ok: true });
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("creates the runtime-supported Jiti boundary for Windows dist loads", () => {
    const createJiti = vi.fn(
      () => vi.fn(() => ({ ok: true })) as unknown as ReturnType<ChannelModuleLoaderJitiFactory>,
    );
    resetChannelPluginModuleLoaderStateForTest();
    setChannelPluginModuleLoaderJitiFactoryForTest(
      createJiti as unknown as ChannelModuleLoaderJitiFactory,
    );
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const rootDir = createTempDir();
      const modulePath = path.join(rootDir, "dist", "extensions", "demo", "index.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, "export const ok = true;\n", "utf8");

      const loaded = loadChannelPluginModule({
        modulePath,
        rootDir,
        shouldTryNativeRequire: () => false,
      });

      expect(loaded).toMatchObject({ ok: true });
      expect(createJiti).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tryNative: false,
        }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});
