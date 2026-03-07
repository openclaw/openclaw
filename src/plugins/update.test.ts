import { beforeEach, describe, expect, it, vi } from "vitest";

const installPluginFromNpmSpecMock = vi.fn();

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string) => `/tmp/${pluginId}`,
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
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
    it("does not trigger onIntegrityDrift when the resolved spec changes (legitimate update)", async () => {
      // npm resolves to a new version → different hash is expected and benign
      installPluginFromNpmSpecMock.mockImplementation(async (args: InstallNpmSpecCallArgs) => {
        // Simulate the infrastructure detecting a hash mismatch and calling onIntegrityDrift
        const proceed = await args.onIntegrityDrift?.({
          spec: "myplugin",
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
                spec: "myplugin",
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
  });
});
