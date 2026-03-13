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

type InstallNpmSpecCallArgs = {
  onIntegrityDrift?: (drift: {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: { resolvedSpec?: string; version?: string };
  }) => Promise<boolean> | boolean;
  [key: string]: unknown;
};

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

  describe("integrity drift on version update", () => {
    it("does not trigger onIntegrityDrift when the resolved spec changes to a new pinned version (legitimate update)", async () => {
      // Scenario: user updated their pinned spec from myplugin@1.0.0 to myplugin@2.0.0.
      // The stored integrity is from v1.0.0, but npm correctly resolves myplugin@2.0.0
      // to itself. Different hash is expected and benign — no drift to report.
      installPluginFromNpmSpecMock.mockImplementation(async (args: InstallNpmSpecCallArgs) => {
        // Simulate the infrastructure detecting a hash mismatch and calling onIntegrityDrift
        const proceed = await args.onIntegrityDrift?.({
          spec: "myplugin@2.0.0",
          expectedIntegrity: "sha512-OLD==",
          actualIntegrity: "sha512-NEW==",
          resolution: { resolvedSpec: "myplugin@2.0.0", version: "2.0.0" },
        });
        if (!proceed) {
          return {
            ok: false,
            error: "aborted: npm package integrity drift detected for myplugin@2.0.0",
          };
        }
        return {
          ok: true,
          pluginId: "myplugin",
          targetDir: "/tmp/myplugin",
          extensions: ["index.ts"],
          version: "2.0.0",
        };
      });

      const outerDriftHandler = vi.fn().mockResolvedValue(true);
      const { updateNpmInstalledPlugins } = await import("./update.js");

      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              myplugin: {
                source: "npm",
                spec: "myplugin@2.0.0",
                installPath: "/tmp/myplugin",
                integrity: "sha512-OLD==",
                resolvedSpec: "myplugin@1.0.0", // previously installed version
                resolvedVersion: "1.0.0",
              },
            },
          },
        },
        pluginIds: ["myplugin"],
        onIntegrityDrift: outerDriftHandler,
      });

      // Update succeeded without prompting the user
      expect(result.outcomes[0]?.status).toBe("updated");
      expect(outerDriftHandler).not.toHaveBeenCalled();
    });

    it("triggers onIntegrityDrift when the same resolved spec has a different hash (possible tampering)", async () => {
      // Same version re-published with different content → suspect
      installPluginFromNpmSpecMock.mockImplementation(async (args: InstallNpmSpecCallArgs) => {
        const proceed = await args.onIntegrityDrift?.({
          spec: "myplugin",
          expectedIntegrity: "sha512-ORIGINAL==",
          actualIntegrity: "sha512-TAMPERED==",
          resolution: { resolvedSpec: "myplugin@1.0.0", version: "1.0.0" },
        });
        if (!proceed) {
          return {
            ok: false,
            error: "aborted: npm package integrity drift detected for myplugin@1.0.0",
          };
        }
        return {
          ok: true,
          pluginId: "myplugin",
          targetDir: "/tmp/myplugin",
          extensions: ["index.ts"],
          version: "1.0.0",
        };
      });

      const outerDriftHandler = vi.fn().mockResolvedValue(false); // user says no
      const { updateNpmInstalledPlugins } = await import("./update.js");

      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              myplugin: {
                source: "npm",
                spec: "myplugin",
                installPath: "/tmp/myplugin",
                integrity: "sha512-ORIGINAL==",
                resolvedSpec: "myplugin@1.0.0", // same version
                resolvedVersion: "1.0.0",
              },
            },
          },
        },
        pluginIds: ["myplugin"],
        onIntegrityDrift: outerDriftHandler,
      });

      // Drift was surfaced to the caller and user rejected
      expect(outerDriftHandler).toHaveBeenCalledOnce();
      expect(result.outcomes[0]?.status).toBe("error");
    });

    it("triggers onIntegrityDrift when npm resolves to a different spec than requested (anomalous registry redirect)", async () => {
      // Spec is pinned to myplugin@2.0.0 but registry returns myplugin@3.0.0 — suspicious.
      // resolvedSpec !== drift.spec, so the skip guard does not apply.
      installPluginFromNpmSpecMock.mockImplementation(async (args: InstallNpmSpecCallArgs) => {
        const proceed = await args.onIntegrityDrift?.({
          spec: "myplugin@2.0.0",
          expectedIntegrity: "sha512-OLD==",
          actualIntegrity: "sha512-UNEXPECTED==",
          resolution: { resolvedSpec: "myplugin@3.0.0", version: "3.0.0" },
        });
        if (!proceed) {
          return {
            ok: false,
            error: "aborted: npm package integrity drift detected for myplugin@2.0.0",
          };
        }
        return {
          ok: true,
          pluginId: "myplugin",
          targetDir: "/tmp/myplugin",
          extensions: ["index.ts"],
          version: "3.0.0",
        };
      });

      const outerDriftHandler = vi.fn().mockResolvedValue(false); // caller blocks
      const { updateNpmInstalledPlugins } = await import("./update.js");

      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              myplugin: {
                source: "npm",
                spec: "myplugin@2.0.0",
                installPath: "/tmp/myplugin",
                integrity: "sha512-OLD==",
                resolvedSpec: "myplugin@1.0.0",
                resolvedVersion: "1.0.0",
              },
            },
          },
        },
        pluginIds: ["myplugin"],
        onIntegrityDrift: outerDriftHandler,
      });

      // Anomalous resolution was surfaced to the caller
      expect(outerDriftHandler).toHaveBeenCalledOnce();
      expect(result.outcomes[0]?.status).toBe("error");
    });
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
