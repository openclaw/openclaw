import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../plugins/sdk-alias.js");
  vi.doUnmock("jiti");
});

function createTempDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-contract-surfaces-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

/** Build minimal mock infrastructure for a single bundled plugin with a contract-api.ts. */
function setupSinglePlugin(contractModulePath: string) {
  vi.doMock("../../plugins/discovery.js", () => ({
    discoverOpenClawPlugins: () => ({ candidates: [], diagnostics: [] }),
  }));

  vi.doMock("../../plugins/manifest-registry.js", () => ({
    loadPluginManifestRegistry: () => ({
      plugins: [
        {
          id: "test-plugin",
          origin: "bundled",
          channels: ["test"],
          rootDir: path.dirname(contractModulePath),
        },
      ],
    }),
  }));

  vi.doMock("../../plugins/sdk-alias.js", () => ({
    buildPluginLoaderAliasMap: () => ({}),
    buildPluginLoaderJitiOptions: () => ({}),
    shouldPreferNativeJiti: () => false,
  }));
}

describe("getBundledChannelContractSurfaceEntries", () => {
  it("loads and caches the surface entries on first call", async () => {
    const pluginDir = createTempDir();
    const contractPath = path.join(pluginDir, "contract-api.ts");
    fs.writeFileSync(contractPath, "export {};\n", "utf8");

    const surface = { kind: "test-surface" };

    setupSinglePlugin(contractPath);

    const loadCount = { value: 0 };
    vi.doMock("jiti", () => ({
      createJiti: () => {
        return (_modulePath: string) => {
          loadCount.value++;
          return surface;
        };
      },
    }));

    const mod = await importFreshModule<typeof import("./contract-surfaces.js")>(
      import.meta.url,
      "./contract-surfaces.js?scope=normal-load",
    );

    const result1 = mod.getBundledChannelContractSurfaceEntries();
    expect(result1).toHaveLength(1);
    expect(result1[0]).toEqual({ pluginId: "test-plugin", surface });
    expect(loadCount.value).toBe(1);

    // Second call hits the cache — loader not called again.
    const result2 = mod.getBundledChannelContractSurfaceEntries();
    expect(result2).toBe(result1);
    expect(loadCount.value).toBe(1);
  });

  it("returns the sentinel empty array for reentrant calls without poisoning the cache", async () => {
    const pluginDir = createTempDir();
    const contractPath = path.join(pluginDir, "contract-api.ts");
    fs.writeFileSync(contractPath, "export {};\n", "utf8");

    const surface = { kind: "test-surface" };

    setupSinglePlugin(contractPath);

    // This reference is filled in once the fresh module is imported below.
    let modRef: typeof import("./contract-surfaces.js") | undefined;
    let reentrantResult: Array<{ pluginId: string; surface: unknown }> | undefined;
    let reentrantSurfacesResult: unknown[] | undefined;

    vi.doMock("jiti", () => ({
      createJiti: () => {
        return (_modulePath: string) => {
          // Reentrant call: both entry-point functions are in-flight right now.
          reentrantResult = modRef!.getBundledChannelContractSurfaceEntries();
          reentrantSurfacesResult = modRef!.getBundledChannelContractSurfaces();
          return surface;
        };
      },
    }));

    modRef = await importFreshModule<typeof import("./contract-surfaces.js")>(
      import.meta.url,
      "./contract-surfaces.js?scope=reentrant-load",
    );

    // Trigger the outer load (which will fire the jiti mock, causing reentrant calls).
    const outerResult = modRef.getBundledChannelContractSurfaceEntries();

    // Reentrant calls must return empty (the guard sentinel / []).
    expect(reentrantResult).toBeDefined();
    expect(reentrantResult).toHaveLength(0);
    expect(reentrantSurfacesResult).toBeDefined();
    expect(reentrantSurfacesResult).toHaveLength(0);

    // Outer call completed with the real data.
    expect(outerResult).toHaveLength(1);
    expect(outerResult[0]).toEqual({ pluginId: "test-plugin", surface });

    // The cache must NOT have been poisoned by the reentrant empty result.
    // A subsequent fresh call returns the fully populated list.
    const postLoadEntries = modRef.getBundledChannelContractSurfaceEntries();
    expect(postLoadEntries).toHaveLength(1);
    expect(postLoadEntries).toBe(outerResult); // same cached reference

    const postLoadSurfaces = modRef.getBundledChannelContractSurfaces();
    expect(postLoadSurfaces).toHaveLength(1);
    expect(postLoadSurfaces[0]).toBe(surface);
  });

  it("skips plugins with no contract-api.ts file", async () => {
    const pluginDir = createTempDir();
    // No contract-api.ts written.

    setupSinglePlugin(path.join(pluginDir, "contract-api.ts"));

    vi.doMock("jiti", () => ({
      createJiti: () => () => ({}),
    }));

    const mod = await importFreshModule<typeof import("./contract-surfaces.js")>(
      import.meta.url,
      "./contract-surfaces.js?scope=missing-contract",
    );

    expect(mod.getBundledChannelContractSurfaceEntries()).toEqual([]);
    expect(mod.getBundledChannelContractSurfaces()).toEqual([]);
  });
});
