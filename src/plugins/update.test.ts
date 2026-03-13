import { beforeEach, describe, expect, it, vi } from "vitest";

const installPluginFromNpmSpecMock = vi.fn();
const installPluginFromMarketplaceMock = vi.fn();
const installPluginFromClawHubMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string) => `/tmp/${pluginId}`,
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
}));

vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplaceMock(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => installPluginFromClawHubMock(...args),
}));

vi.mock("./bundled-sources.js", () => ({
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSourcesMock(...args),
}));

const { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } = await import("./update.js");

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
    installPluginFromMarketplaceMock.mockReset();
    installPluginFromClawHubMock.mockReset();
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

  it("reuses a recorded npm dist-tag spec for id-based updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server@beta",
              installPath: "/tmp/openclaw-codex-app-server",
              resolvedName: "openclaw-codex-app-server",
              resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.3",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
    expect(result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
      source: "npm",
      spec: "openclaw-codex-app-server@beta",
      installPath: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
    });
  });

  it("uses and persists an explicit npm spec override during updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
      npmResolution: {
        name: "openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server",
              installPath: "/tmp/openclaw-codex-app-server",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
    expect(result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
      source: "npm",
      spec: "openclaw-codex-app-server@beta",
      installPath: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    });
  });

  it("updates ClawHub-installed plugins via recorded package metadata", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.4",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            demo: {
              source: "clawhub",
              spec: "clawhub:demo",
              installPath: "/tmp/demo",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "demo",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
            },
          },
        },
      },
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
        mode: "update",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.2.4",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: "sha256-next",
    });
  });

  it("skips recorded integrity checks when an explicit npm version override changes the spec", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
    });

    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server@0.2.0-beta.3",
              integrity: "sha512-old",
              installPath: "/tmp/openclaw-codex-app-server",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@0.2.0-beta.4",
        expectedIntegrity: undefined,
      }),
    );
  });

  it("migrates legacy unscoped install keys when a scoped npm package updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "@openclaw/voice-call",
      targetDir: "/tmp/openclaw-voice-call",
      version: "0.0.2",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          allow: ["voice-call"],
          deny: ["voice-call"],
          slots: { memory: "voice-call" },
          entries: {
            "voice-call": {
              enabled: false,
              hooks: { allowPromptInjection: false },
            },
          },
          installs: {
            "voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call",
              installPath: "/tmp/voice-call",
            },
          },
        },
      },
      pluginIds: ["voice-call"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
      }),
    );
    expect(result.config.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.slots?.memory).toBe("@openclaw/voice-call");
    expect(result.config.plugins?.entries?.["@openclaw/voice-call"]).toEqual({
      enabled: false,
      hooks: { allowPromptInjection: false },
    });
    expect(result.config.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.config.plugins?.installs?.["@openclaw/voice-call"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/voice-call",
      installPath: "/tmp/openclaw-voice-call",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["voice-call"]).toBeUndefined();
  });

  it("checks marketplace installs during dry-run updates", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.2.0",
      extensions: ["index.ts"],
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "claude-bundle": {
              source: "marketplace",
              marketplaceSource: "vincentkoc/claude-marketplace",
              marketplacePlugin: "claude-bundle",
              installPath: "/tmp/claude-bundle",
            },
          },
        },
      },
      pluginIds: ["claude-bundle"],
      dryRun: true,
    });

    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "vincentkoc/claude-marketplace",
        plugin: "claude-bundle",
        expectedPluginId: "claude-bundle",
        dryRun: true,
      }),
    );
    expect(result.outcomes).toEqual([
      {
        pluginId: "claude-bundle",
        status: "updated",
        currentVersion: undefined,
        nextVersion: "1.2.0",
        message: "Would update claude-bundle: unknown -> 1.2.0.",
      },
    ]);
  });

  it("updates marketplace installs and preserves source metadata", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.3.0",
      extensions: ["index.ts"],
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "claude-bundle": {
              source: "marketplace",
              marketplaceName: "Vincent's Claude Plugins",
              marketplaceSource: "vincentkoc/claude-marketplace",
              marketplacePlugin: "claude-bundle",
              installPath: "/tmp/claude-bundle",
            },
          },
        },
      },
      pluginIds: ["claude-bundle"],
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.["claude-bundle"]).toMatchObject({
      source: "marketplace",
      installPath: "/tmp/claude-bundle",
      version: "1.3.0",
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",

  describe("integrity drift on version update", () => {
    it("does not trigger onIntegrityDrift when the resolved spec changes (legitimate update)", async () => {
      installPluginFromNpmSpecMock.mockImplementation(async (args: InstallNpmSpecCallArgs) => {
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

      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              myplugin: {
                source: "npm",
                spec: "myplugin",
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

      expect(result.outcomes[0]?.status).toBe("updated");
      expect(outerDriftHandler).not.toHaveBeenCalled();
    });

    it("triggers onIntegrityDrift when the same resolved spec has a different hash (possible tampering)", async () => {
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

      const outerDriftHandler = vi.fn().mockResolvedValue(false);

      const result = await updateNpmInstalledPlugins({
        config: {
          plugins: {
            installs: {
              myplugin: {
                source: "npm",
                spec: "myplugin",
                installPath: "/tmp/myplugin",
                integrity: "sha512-ORIGINAL==",
                resolvedSpec: "myplugin@1.0.0",
                resolvedVersion: "1.0.0",
              },
            },
          },
        },
        pluginIds: ["myplugin"],
        onIntegrityDrift: outerDriftHandler,
      });

      expect(outerDriftHandler).toHaveBeenCalledOnce();
      expect(result.outcomes[0]?.status).toBe("error");
    });
  });

  it("reuses a recorded npm dist-tag spec for id-based updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server@beta",
              installPath: "/tmp/openclaw-codex-app-server",
              resolvedName: "openclaw-codex-app-server",
              resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.3",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
    expect(result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
      source: "npm",
      spec: "openclaw-codex-app-server@beta",
      installPath: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
    });
  });

  it("uses and persists an explicit npm spec override during updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
      npmResolution: {
        name: "openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server",
              installPath: "/tmp/openclaw-codex-app-server",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
    expect(result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
      source: "npm",
      spec: "openclaw-codex-app-server@beta",
      installPath: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    });
  });

  it("updates ClawHub-installed plugins via recorded package metadata", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.4",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            demo: {
              source: "clawhub",
              spec: "clawhub:demo",
              installPath: "/tmp/demo",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "demo",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
            },
          },
        },
      },
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
        mode: "update",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.2.4",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: "sha256-next",
    });
  });

  it("skips recorded integrity checks when an explicit npm version override changes the spec", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "openclaw-codex-app-server",
      targetDir: "/tmp/openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      extensions: ["index.ts"],
    });

    await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "openclaw-codex-app-server": {
              source: "npm",
              spec: "openclaw-codex-app-server@0.2.0-beta.3",
              integrity: "sha512-old",
              installPath: "/tmp/openclaw-codex-app-server",
            },
          },
        },
      },
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@0.2.0-beta.4",
        expectedIntegrity: undefined,
      }),
    );
  });

  it("migrates legacy unscoped install keys when a scoped npm package updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "@openclaw/voice-call",
      targetDir: "/tmp/openclaw-voice-call",
      version: "0.0.2",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          allow: ["voice-call"],
          deny: ["voice-call"],
          slots: { memory: "voice-call" },
          entries: {
            "voice-call": {
              enabled: false,
              hooks: { allowPromptInjection: false },
            },
          },
          installs: {
            "voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call",
              installPath: "/tmp/voice-call",
            },
          },
        },
      },
      pluginIds: ["voice-call"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
      }),
    );
    expect(result.config.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.slots?.memory).toBe("@openclaw/voice-call");
    expect(result.config.plugins?.entries?.["@openclaw/voice-call"]).toEqual({
      enabled: false,
      hooks: { allowPromptInjection: false },
    });
    expect(result.config.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.config.plugins?.installs?.["@openclaw/voice-call"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/voice-call",
      installPath: "/tmp/openclaw-voice-call",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["voice-call"]).toBeUndefined();
  });

  it("checks marketplace installs during dry-run updates", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.2.0",
      extensions: ["index.ts"],
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "claude-bundle": {
              source: "marketplace",
              marketplaceSource: "vincentkoc/claude-marketplace",
              marketplacePlugin: "claude-bundle",
              installPath: "/tmp/claude-bundle",
            },
          },
        },
      },
      pluginIds: ["claude-bundle"],
      dryRun: true,
    });

    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "vincentkoc/claude-marketplace",
        plugin: "claude-bundle",
        expectedPluginId: "claude-bundle",
        dryRun: true,
      }),
    );
    expect(result.outcomes).toEqual([
      {
        pluginId: "claude-bundle",
        status: "updated",
        currentVersion: undefined,
        nextVersion: "1.2.0",
        message: "Would update claude-bundle: unknown -> 1.2.0.",
      },
    ]);
  });

  it("updates marketplace installs and preserves source metadata", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.3.0",
      extensions: ["index.ts"],
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "claude-bundle": {
              source: "marketplace",
              marketplaceName: "Vincent's Claude Plugins",
              marketplaceSource: "vincentkoc/claude-marketplace",
              marketplacePlugin: "claude-bundle",
              installPath: "/tmp/claude-bundle",
            },
          },
        },
      },
      pluginIds: ["claude-bundle"],
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.["claude-bundle"]).toMatchObject({
      source: "marketplace",
      installPath: "/tmp/claude-bundle",
      version: "1.3.0",
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
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
