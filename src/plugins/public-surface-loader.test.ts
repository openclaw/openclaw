import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-public-surface-loader-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("bundled plugin public surface loader", () => {
  it("keeps Windows dist public artifact loads off Jiti native import", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "windows-dist-ok" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(import.meta.url, "./public-surface-loader.js?scope=windows-dist-jiti");
      const tempRoot = createTempDir();
      const bundledPluginsDir = path.join(tempRoot, "dist");
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

      const modulePath = path.join(bundledPluginsDir, "demo", "provider-policy-api.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, 'export const marker = "windows-dist-ok";\n', "utf8");

      expect(
        publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "provider-policy-api.js",
        }).marker,
      ).toBe("windows-dist-ok");
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

  it("prefers source require for bundled source public artifacts when a ts require hook exists", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "jiti-should-not-run" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const requireLoader = Object.assign(
      vi.fn(() => ({ marker: "source-require-ok" })),
      {
        extensions: {
          ".ts": vi.fn(),
        },
      },
    );
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return Object.assign({}, actual, {
        createRequire: vi.fn(() => requireLoader),
      });
    });

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=source-require-fast-path");
    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "extensions");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "secret-contract-api.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "source-require-ok";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "secret-contract-api.js",
      }).marker,
    ).toBe("source-require-ok");
    expect(requireLoader).toHaveBeenCalledWith(path.resolve(modulePath));
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("reuses one bundled dist jiti loader across public artifacts with the same native mode", async () => {
    const createJiti = vi.fn(() => vi.fn((modulePath: string) => ({ modulePath })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=shared-bundled-jiti");
    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const firstPath = path.join(bundledPluginsDir, "demo-a", "api.js");
    const secondPath = path.join(bundledPluginsDir, "demo-b", "api.js");
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.writeFileSync(firstPath, 'export const marker = "demo-a";\n', "utf8");
    fs.writeFileSync(secondPath, 'export const marker = "demo-b";\n', "utf8");

    publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ modulePath: string }>({
      dirName: "demo-a",
      artifactBasename: "api.js",
    });
    publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ modulePath: string }>({
      dirName: "demo-b",
      artifactBasename: "api.js",
    });

    expect(createJiti).toHaveBeenCalledTimes(1);
  });

  it("throws and does not cache when module loader returns null", async () => {
    const createJiti = vi.fn(() => vi.fn(() => null));
    vi.doMock("jiti", () => ({
      createJiti,
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=null-loader");

    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "null-api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export default null;\n", "utf8");

    let thrown: unknown;
    try {
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "null-api.js",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("null/undefined");

    // Subsequent call should attempt to load again, not return cached bad value
    let thrownAgain: unknown;
    try {
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "null-api.js",
      });
    } catch (err) {
      thrownAgain = err;
    }
    expect(thrownAgain).toBeInstanceOf(Error);
    expect((thrownAgain as Error).message).toContain("null/undefined");
    // Confirms no caching of bad value
    expect(createJiti).toHaveBeenCalled();
  });

  it("throws and does not cache when jiti returns broken proxy with null target", async () => {
    // Create a proxy with null target - exactly the failure mode from #62844
    const brokenProxy = new Proxy(
      {},
      {
        get(_target, _prop) {
          // Simulate the exact error: accessing a property throws because target is null
          throw new TypeError("Cannot read properties of undefined (reading 't')");
        },
      },
    );
    const createJiti = vi.fn(() => vi.fn(() => brokenProxy));
    vi.doMock("jiti", () => ({
      createJiti,
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=broken-proxy");

    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "broken-api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export default {};\n", "utf8");

    // First call should throw due to broken proxy validation
    let thrown: unknown;
    try {
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "broken-api.js",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("inaccessible proxy");

    // Subsequent call should NOT return cached bad proxy — should try to load again and throw again
    let thrownAgain: unknown;
    try {
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "broken-api.js",
      });
    } catch (err) {
      thrownAgain = err;
    }
    expect(thrownAgain).toBeInstanceOf(Error);
    expect((thrownAgain as Error).message).toContain("inaccessible proxy");
    // Confirms no caching of bad proxy
    expect(createJiti).toHaveBeenCalled();
  });
});
