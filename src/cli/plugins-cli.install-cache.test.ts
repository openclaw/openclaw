import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = vi.fn();
  return {
    ...actual,
    existsSync,
    default: {
      ...actual,
      existsSync,
    },
  };
});

const loadConfig = vi.fn();
const writeConfigFile = vi.fn();
vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  writeConfigFile: (...args: unknown[]) => writeConfigFile(...args),
}));

const installPluginFromPath = vi.fn();
const installPluginFromNpmSpec = vi.fn();
vi.mock("../plugins/install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPath(...args),
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
}));

const clearPluginDiscoveryCache = vi.fn();
vi.mock("../plugins/discovery.js", () => ({
  clearPluginDiscoveryCache: () => clearPluginDiscoveryCache(),
}));

const clearPluginManifestRegistryCache = vi.fn();
vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => clearPluginManifestRegistryCache(),
}));

const buildPluginStatusReport = vi.fn();
vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: (...args: unknown[]) => buildPluginStatusReport(...args),
}));

const applyExclusiveSlotSelection = vi.fn();
vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: (...args: unknown[]) => applyExclusiveSlotSelection(...args),
}));

const findBundledPluginSource = vi.fn();
vi.mock("../plugins/bundled-sources.js", () => ({
  findBundledPluginSource: (...args: unknown[]) => findBundledPluginSource(...args),
}));

const resolvePinnedNpmInstallRecordForCli = vi.fn();
vi.mock("./npm-resolution.js", () => ({
  resolvePinnedNpmInstallRecordForCli: (...args: unknown[]) =>
    resolvePinnedNpmInstallRecordForCli(...args),
}));

const defaultRuntime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};
vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

describe("plugins cli install cache invalidation", () => {
  let registerPluginsCli: (typeof import("./plugins-cli.js"))["registerPluginsCli"];

  beforeAll(async () => {
    ({ registerPluginsCli } = await import("./plugins-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({
      plugins: {
        allow: ["telegram"],
      },
    });
    buildPluginStatusReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "repro-openclaw-plugin", kind: undefined }],
      workspaceDir: "/tmp/workspace",
    });
    applyExclusiveSlotSelection.mockImplementation(({ config }: { config: unknown }) => ({
      config,
      warnings: [],
    }));
    findBundledPluginSource.mockReturnValue(undefined);
    resolvePinnedNpmInstallRecordForCli.mockReturnValue({
      installPath: "/tmp/state/extensions/repro-openclaw-plugin",
      source: "npm",
      spec: "repro-openclaw-plugin",
      version: "1.0.0",
    });
    writeConfigFile.mockImplementation(async () => {
      if (clearPluginDiscoveryCache.mock.calls.length === 0) {
        throw new Error(
          "Config validation failed: plugins.allow: plugin not found: repro-openclaw-plugin",
        );
      }
    });
  });

  it("clears discovery cache before writing config for local plugin installs", async () => {
    const pluginPath = path.resolve("/tmp/repro-openclaw-plugin");
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => path.resolve(String(candidate)) === pluginPath,
    );
    installPluginFromPath.mockResolvedValue({
      ok: true,
      pluginId: "repro-openclaw-plugin",
      targetDir: "/tmp/state/extensions/repro-openclaw-plugin",
      version: "1.0.0",
    });

    await runRegisteredCli({
      register: registerPluginsCli,
      argv: ["plugins", "install", pluginPath],
    });

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(clearPluginDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(clearPluginDiscoveryCache.mock.invocationCallOrder[0]).toBeLessThan(
      writeConfigFile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining(["telegram", "repro-openclaw-plugin"]),
          entries: expect.objectContaining({
            "repro-openclaw-plugin": expect.objectContaining({ enabled: true }),
          }),
          installs: expect.objectContaining({
            "repro-openclaw-plugin": expect.objectContaining({
              installPath: "/tmp/state/extensions/repro-openclaw-plugin",
              source: "path",
              sourcePath: pluginPath,
            }),
          }),
        }),
      }),
    );
  });

  it("clears discovery cache before writing config for npm plugin installs", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      npmResolution: {
        integrity: "sha512-demo",
        resolvedName: "repro-openclaw-plugin",
        resolvedSpec: "repro-openclaw-plugin@1.0.0",
        resolvedVersion: "1.0.0",
        shasum: "deadbeef",
      },
      pluginId: "repro-openclaw-plugin",
      targetDir: "/tmp/state/extensions/repro-openclaw-plugin",
      version: "1.0.0",
    });

    await runRegisteredCli({
      register: registerPluginsCli,
      argv: ["plugins", "install", "repro-openclaw-plugin"],
    });

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(clearPluginDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(clearPluginDiscoveryCache.mock.invocationCallOrder[0]).toBeLessThan(
      writeConfigFile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining(["telegram", "repro-openclaw-plugin"]),
          entries: expect.objectContaining({
            "repro-openclaw-plugin": expect.objectContaining({ enabled: true }),
          }),
          installs: expect.objectContaining({
            "repro-openclaw-plugin": expect.objectContaining({
              installPath: "/tmp/state/extensions/repro-openclaw-plugin",
              source: "npm",
              spec: "repro-openclaw-plugin",
            }),
          }),
        }),
      }),
    );
  });
});
