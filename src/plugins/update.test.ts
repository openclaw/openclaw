import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installPluginFromNpmSpecMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();
const resolveNpmSpecMetadataMock = vi.fn();
let tempDirs: string[] = [];

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string) => `/tmp/${pluginId}`,
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
}));

vi.mock("./bundled-sources.js", () => ({
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSourcesMock(...args),
}));

vi.mock("../infra/install-source-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/install-source-utils.js")>();
  return {
    ...actual,
    resolveNpmSpecMetadata: (...args: unknown[]) => resolveNpmSpecMetadataMock(...args),
  };
});

describe("updateNpmInstalledPlugins", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
    resolveNpmSpecMetadataMock.mockReset();
    resolveNpmSpecMetadataMock.mockResolvedValue({
      ok: true,
      metadata: {
        name: "@openclaw/test-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/test-plugin@0.2.6",
        integrity: "sha512-registry",
        shasum: "registry-shasum",
      },
    });
  });

  it("skips reinstalling already up-to-date plugins before download", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-update-"));
    tempDirs.push(root);
    const installPath = path.join(root, "plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@openclaw/test-plugin", version: "0.2.6" }),
    );

    const { updateNpmInstalledPlugins } = await import("./update.js");
    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            test: {
              source: "npm",
              spec: "@openclaw/test-plugin",
              installPath,
            },
          },
        },
      },
      pluginIds: ["test"],
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      {
        pluginId: "test",
        status: "unchanged",
        currentVersion: "0.2.6",
        nextVersion: "0.2.6",
        message: "test already at 0.2.6.",
      },
    ]);
  });

  it("does not skip pinned installs when npm metadata shows integrity drift", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-update-drift-"));
    tempDirs.push(root);
    const installPath = path.join(root, "plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@openclaw/test-plugin", version: "0.2.6" }),
    );
    resolveNpmSpecMetadataMock.mockResolvedValueOnce({
      ok: true,
      metadata: {
        name: "@openclaw/test-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/test-plugin@0.2.6",
        integrity: "sha512-new",
        shasum: "new-shasum",
      },
    });
    installPluginFromNpmSpecMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "test",
      targetDir: installPath,
      version: "0.2.6",
      extensions: ["index.ts"],
      npmResolution: {
        name: "@openclaw/test-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/test-plugin@0.2.6",
        integrity: "sha512-new",
        shasum: "new-shasum",
        resolvedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            test: {
              source: "npm",
              spec: "@openclaw/test-plugin@0.2.6",
              integrity: "sha512-old",
              shasum: "old-shasum",
              installPath,
            },
          },
        },
      },
      pluginIds: ["test"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installer when probe metadata no longer matches the last validated artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-update-mismatch-"));
    tempDirs.push(root);
    const installPath = path.join(root, "plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@openclaw/original-plugin", version: "0.2.6" }),
    );
    resolveNpmSpecMetadataMock.mockResolvedValueOnce({
      ok: true,
      metadata: {
        name: "@openclaw/other-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/other-plugin@0.2.6",
        integrity: "sha512-other",
        shasum: "other-shasum",
      },
    });
    installPluginFromNpmSpecMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "test",
      targetDir: installPath,
      version: "0.2.6",
      extensions: ["index.ts"],
      npmResolution: {
        name: "@openclaw/other-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/other-plugin@0.2.6",
        integrity: "sha512-other",
        shasum: "other-shasum",
        resolvedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            test: {
              source: "npm",
              spec: "@openclaw/other-plugin",
              resolvedSpec: "@openclaw/original-plugin@0.2.6",
              resolvedName: "@openclaw/original-plugin",
              resolvedVersion: "0.2.6",
              installPath,
            },
          },
        },
      },
      pluginIds: ["test"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installer when the probe throws", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-update-probe-error-"));
    tempDirs.push(root);
    const installPath = path.join(root, "plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@openclaw/test-plugin", version: "0.2.6" }),
    );
    resolveNpmSpecMetadataMock.mockRejectedValueOnce(new Error("spawn npm ENOENT"));
    installPluginFromNpmSpecMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "test",
      targetDir: installPath,
      version: "0.2.6",
      extensions: ["index.ts"],
      npmResolution: {
        name: "@openclaw/test-plugin",
        version: "0.2.6",
        resolvedSpec: "@openclaw/test-plugin@0.2.6",
        integrity: "sha512-registry",
        shasum: "registry-shasum",
        resolvedAt: "2026-03-09T00:00:00.000Z",
      },
    });
    const warn = vi.fn();

    const { updateNpmInstalledPlugins } = await import("./update.js");
    await updateNpmInstalledPlugins({
      logger: { warn },
      config: {
        plugins: {
          installs: {
            test: {
              source: "npm",
              spec: "@openclaw/test-plugin",
              installPath,
            },
          },
        },
      },
      pluginIds: ["test"],
    });

    expect(warn).toHaveBeenCalledWith('Skipping pre-check for "test": Error: spawn npm ENOENT');
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installed manifest version when the installer omits version metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-update-manifest-"));
    tempDirs.push(root);
    const installPath = path.join(root, "plugin");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@openclaw/test-plugin", version: "0.2.6" }),
    );
    resolveNpmSpecMetadataMock.mockResolvedValueOnce({
      ok: true,
      metadata: {
        name: "@openclaw/test-plugin",
        version: "0.2.7",
        resolvedSpec: "@openclaw/test-plugin@0.2.7",
        integrity: "sha512-registry",
        shasum: "registry-shasum",
      },
    });
    installPluginFromNpmSpecMock.mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(installPath, "package.json"),
        JSON.stringify({ name: "@openclaw/test-plugin", version: "0.2.7" }),
      );
      return {
        ok: true,
        pluginId: "test",
        targetDir: installPath,
        version: undefined,
        extensions: ["index.ts"],
        npmResolution: {
          name: "@openclaw/test-plugin",
          version: "0.2.7",
          resolvedSpec: "@openclaw/test-plugin@0.2.7",
          integrity: "sha512-registry",
          shasum: "registry-shasum",
          resolvedAt: "2026-03-09T00:00:00.000Z",
        },
      };
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            test: {
              source: "npm",
              spec: "@openclaw/test-plugin",
              installPath,
            },
          },
        },
      },
      pluginIds: ["test"],
    });

    expect(result.outcomes).toEqual([
      {
        pluginId: "test",
        status: "updated",
        currentVersion: "0.2.6",
        nextVersion: "0.2.7",
        message: "Updated test: 0.2.6 -> 0.2.7.",
      },
    ]);
  });

  it("skips integrity drift checks for unpinned npm specs during dry-run updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "opik-openclaw",
      targetDir: "/tmp/opik-openclaw",
      version: "0.2.6",
      extensions: ["index.ts"],
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "opik-openclaw": {
              source: "npm",
              spec: "@opik/opik-openclaw",
              integrity: "sha512-old",
              installPath: "/tmp/opik-openclaw",
            },
          },
        },
      },
      pluginIds: ["opik-openclaw"],
      dryRun: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@opik/opik-openclaw",
        expectedIntegrity: undefined,
      }),
    );
  });

  it("keeps integrity drift checks for exact-version npm specs during dry-run updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "opik-openclaw",
      targetDir: "/tmp/opik-openclaw",
      version: "0.2.6",
      extensions: ["index.ts"],
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "opik-openclaw": {
              source: "npm",
              spec: "@opik/opik-openclaw@0.2.5",
              integrity: "sha512-old",
              installPath: "/tmp/opik-openclaw",
            },
          },
        },
      },
      pluginIds: ["opik-openclaw"],
      dryRun: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@opik/opik-openclaw@0.2.5",
        expectedIntegrity: "sha512-old",
      }),
    );
  });

  it("formats package-not-found updates with a stable message", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      code: "npm_package_not_found",
      error: "Package not found on npm: @openclaw/missing.",
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            missing: {
              source: "npm",
              spec: "@openclaw/missing",
              installPath: "/tmp/missing",
            },
          },
        },
      },
      pluginIds: ["missing"],
      dryRun: true,
    });

    expect(result.outcomes).toEqual([
      {
        pluginId: "missing",
        status: "error",
        message: "Failed to check missing: npm package not found for @openclaw/missing.",
      },
    ]);
  });

  it("falls back to raw installer error for unknown error codes", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      code: "invalid_npm_spec",
      error: "unsupported npm spec: github:evil/evil",
    });

    const { updateNpmInstalledPlugins } = await import("./update.js");
    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            bad: {
              source: "npm",
              spec: "github:evil/evil",
              installPath: "/tmp/bad",
            },
          },
        },
      },
      pluginIds: ["bad"],
      dryRun: true,
    });

    expect(result.outcomes).toEqual([
      {
        pluginId: "bad",
        status: "error",
        message: "Failed to check bad: unsupported npm spec: github:evil/evil",
      },
    ]);
  });
});

describe("syncPluginsForUpdateChannel", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
  });

  it("keeps bundled path installs on beta without reinstalling from npm", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "feishu",
          {
            pluginId: "feishu",
            localPath: "/app/extensions/feishu",
            npmSpec: "@openclaw/feishu",
          },
        ],
      ]),
    );

    const { syncPluginsForUpdateChannel } = await import("./update.js");
    const result = await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {
        plugins: {
          load: { paths: ["/app/extensions/feishu"] },
          installs: {
            feishu: {
              source: "path",
              sourcePath: "/app/extensions/feishu",
              installPath: "/app/extensions/feishu",
              spec: "@openclaw/feishu",
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.summary.switchedToNpm).toEqual([]);
    expect(result.config.plugins?.load?.paths).toEqual(["/app/extensions/feishu"]);
    expect(result.config.plugins?.installs?.feishu?.source).toBe("path");
  });

  it("repairs bundled install metadata when the load path is re-added", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "feishu",
          {
            pluginId: "feishu",
            localPath: "/app/extensions/feishu",
            npmSpec: "@openclaw/feishu",
          },
        ],
      ]),
    );

    const { syncPluginsForUpdateChannel } = await import("./update.js");
    const result = await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {
        plugins: {
          load: { paths: [] },
          installs: {
            feishu: {
              source: "path",
              sourcePath: "/app/extensions/feishu",
              installPath: "/tmp/old-feishu",
              spec: "@openclaw/feishu",
            },
          },
        },
      },
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.load?.paths).toEqual(["/app/extensions/feishu"]);
    expect(result.config.plugins?.installs?.feishu).toMatchObject({
      source: "path",
      sourcePath: "/app/extensions/feishu",
      installPath: "/app/extensions/feishu",
      spec: "@openclaw/feishu",
    });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("forwards an explicit env to bundled plugin source resolution", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const { syncPluginsForUpdateChannel } = await import("./update.js");
    await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {},
      workspaceDir: "/workspace",
      env,
    });

    expect(resolveBundledPluginSourcesMock).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      env,
    });
  });

  it("uses the provided env when matching bundled load and install paths", async () => {
    const bundledHome = "/tmp/openclaw-home";
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "feishu",
          {
            pluginId: "feishu",
            localPath: `${bundledHome}/plugins/feishu`,
            npmSpec: "@openclaw/feishu",
          },
        ],
      ]),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/process-home";
    try {
      const { syncPluginsForUpdateChannel } = await import("./update.js");
      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        env: {
          ...process.env,
          OPENCLAW_HOME: bundledHome,
          HOME: "/tmp/ignored-home",
        },
        config: {
          plugins: {
            load: { paths: ["~/plugins/feishu"] },
            installs: {
              feishu: {
                source: "path",
                sourcePath: "~/plugins/feishu",
                installPath: "~/plugins/feishu",
                spec: "@openclaw/feishu",
              },
            },
          },
        },
      });

      expect(result.changed).toBe(false);
      expect(result.config.plugins?.load?.paths).toEqual(["~/plugins/feishu"]);
      expect(result.config.plugins?.installs?.feishu).toMatchObject({
        source: "path",
        sourcePath: "~/plugins/feishu",
        installPath: "~/plugins/feishu",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});
