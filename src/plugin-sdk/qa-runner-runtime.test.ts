import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const listBundledQaRunnerCatalog = vi.hoisted(() =>
  vi.fn<
    () => Array<{
      pluginId: string;
      commandName: string;
      description?: string;
      npmSpec: string;
    }>
  >(() => []),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("../plugins/qa-runner-catalog.js", () => ({
  listBundledQaRunnerCatalog,
}));

vi.mock("./facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk qa-runner-runtime", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    listBundledQaRunnerCatalog.mockReset().mockReturnValue([]);
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until runner discovery is requested", async () => {
    await import("./qa-runner-runtime.js");

    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("returns activated runner registrations declared in plugin manifests", async () => {
    const register = vi.fn((qa: Command) => qa);
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          qaRunners: [
            {
              commandName: "matrix",
              description: "Run the Matrix live QA lane",
            },
          ],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [{ commandName: "matrix", register }],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
        status: "available",
        registration: {
          commandName: "matrix",
          register,
        },
      },
    ]);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-matrix",
      artifactBasename: "runtime-api.js",
    });
  });

  it("reports declared runners as blocked when the plugin is present but not activated", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        status: "blocked",
      },
    ]);
  });

  it("reports missing optional runners from the generated catalog", async () => {
    listBundledQaRunnerCatalog.mockReturnValue([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
        npmSpec: "@openclaw/qa-matrix",
      },
    ]);

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
        status: "missing",
        npmSpec: "@openclaw/qa-matrix",
      },
    ]);
  });

  it("fails fast when two plugins declare the same qa runner command", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/alpha",
        },
        {
          id: "beta",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/beta",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner command "matrix" declared by both "alpha" and "beta"',
    );
  });

  it("fails when runtime registrations include an undeclared command", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [
        { commandName: "matrix", register: vi.fn() },
        { commandName: "extra", register: vi.fn() },
      ],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner plugin "qa-matrix" exported "extra" from runtime-api.js but did not declare it in openclaw.plugin.json',
    );
  });
});
