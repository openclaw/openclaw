import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const installPluginFromNpmSpecMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();

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

describe("updateNpmInstalledPlugins", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
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

  it("normalizes tilde install paths before reading the installed version", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-home-"));
    const installDir = path.join(homeDir, "plugins", "demo");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf-8",
    );

    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: installDir,
      version: "1.2.3",
      extensions: ["index.js"],
    });

    try {
      const { updateNpmInstalledPlugins } = await import("./update.js");
      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              demo: {
                source: "npm",
                spec: "demo@1.2.3",
                installPath: "~/plugins/demo",
              },
            },
          },
        },
        pluginIds: ["demo"],
        dryRun: true,
        env: {
          ...process.env,
          HOME: homeDir,
        },
      });

      expect(result.outcomes).toEqual([
        {
          pluginId: "demo",
          status: "unchanged",
          currentVersion: "1.2.3",
          nextVersion: "1.2.3",
          message: "demo is up to date (1.2.3).",
        },
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
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
