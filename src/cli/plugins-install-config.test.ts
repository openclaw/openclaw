// Plugin install config tests cover install specs and generated plugin config.
import fs from "node:fs";
import { bundledPluginRootAt, repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { loadConfigForInstall } from "./plugins-install-command.js";

const hoisted = vi.hoisted(() => ({
  readConfigFileSnapshotMock: vi.fn<() => Promise<ConfigFileSnapshot>>(),
  collectChannelDoctorStaleConfigMutationsMock: vi.fn(),
  loadInstalledPluginIndexInstallRecordsMock: vi.fn(),
}));

const readConfigFileSnapshotMock = hoisted.readConfigFileSnapshotMock;
const collectChannelDoctorStaleConfigMutationsMock =
  hoisted.collectChannelDoctorStaleConfigMutationsMock;
const loadInstalledPluginIndexInstallRecordsMock =
  hoisted.loadInstalledPluginIndexInstallRecordsMock;

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorStaleConfigMutations: (cfg: OpenClawConfig) =>
    collectChannelDoctorStaleConfigMutationsMock(cfg),
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: () => loadInstalledPluginIndexInstallRecordsMock(),
  };
});

const DISCORD_REPO_INSTALL_SPEC = repoInstallSpec("discord");

function makeSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/config.json5",
    exists: true,
    raw: '{ "plugins": {} }',
    parsed: { plugins: {} },
    sourceConfig: { plugins: {} } as ConfigFileSnapshot["sourceConfig"],
    resolved: { plugins: {} } as OpenClawConfig,
    valid: false,
    runtimeConfig: { plugins: {} } as ConfigFileSnapshot["runtimeConfig"],
    config: { plugins: {} } as OpenClawConfig,
    hash: "abc",
    issues: [{ path: "plugins.installs.discord", message: "stale path" }],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("loadConfigForInstall", () => {
  const discordNpmRequest = {
    rawSpec: "@openclaw/discord",
    normalizedSpec: "@openclaw/discord",
    bundledPluginId: "discord",
    allowInvalidConfigRecovery: true,
  } satisfies PluginInstallRequestContext;

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    readConfigFileSnapshotMock.mockReset();
    collectChannelDoctorStaleConfigMutationsMock.mockReset();
    loadInstalledPluginIndexInstallRecordsMock.mockReset();

    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({});
    collectChannelDoctorStaleConfigMutationsMock.mockImplementation(async (cfg: OpenClawConfig) => [
      {
        config: cfg,
        changes: [],
      },
    ]);
  });

  it("returns the source config and base hash when the snapshot is valid", async () => {
    const cfg = { plugins: { entries: { discord: { enabled: true } } } } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: { plugins: { entries: { discord: { enabled: true } }, enabled: true } },
        hash: "config-1",
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result).toEqual({ config: cfg, baseHash: "config-1" });
  });

  it("does not run stale Discord cleanup on the happy path", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: cfg,
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result.config).toBe(cfg);
  });

  it("falls back to snapshot config for explicit bundled-plugin reinstall when issues match the known upgrade failure", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows npm:-prefixed bundled-plugin reinstall recovery", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "npm:@openclaw/discord",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.bundledPluginId).toBe("discord");
    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows versioned official npm spec reinstall recovery", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone", "/keep"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} }, load: { paths: ["/gone", "/keep"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.bundledPluginId).toBe("discord");
    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      config: {
        plugins: {
          installs: { discord: { source: "npm", installPath: "/gone" } },
          load: { paths: ["/keep"] },
        },
      },
      baseHash: "abc",
    });
  });

  it("does not classify file-normalized versioned paths as official recovery specs", () => {
    const request = resolvePluginInstallRequestContext({
      rawSpec: "file:@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.allowInvalidConfigRecovery).toBeUndefined();
    expect(request.request.bundledPluginId).toBeUndefined();
  });

  it("does not classify registry-like local paths as official recovery specs", () => {
    const existsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
      String(candidate).endsWith("@openclaw/discord@2026.5.22") ? true : existsSync(candidate),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.allowInvalidConfigRecovery).toBeUndefined();
    expect(request.request.bundledPluginId).toBeUndefined();
  });

  it("rejects recovery when removing a stale path would shift authored env refs", async () => {
    vi.stubEnv("OPENCLAW_TEST_PLUGIN_DIR", "/custom/plugin");
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone", "/custom/plugin"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: {} },
            load: { paths: ["/gone", "${OPENCLAW_TEST_PLUGIN_DIR}"] },
          },
        },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    await expect(loadConfigForInstall(request.request)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
  });

  it("matches missing load paths against persisted install records", async () => {
    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({
      discord: { source: "npm", installPath: "/gone" },
    });
    const snapshotCfg = {
      plugins: { load: { paths: ["/gone", "/keep"] } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { load: { paths: ["/gone", "/keep"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    const result = await loadConfigForInstall(request.request);
    expect(result.config).toEqual({
      plugins: { load: { paths: ["/keep"] } },
    });
  });

  it("prefers persisted install records over stale legacy config install records", async () => {
    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({
      discord: { source: "npm", installPath: "/canonical" },
    });
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/legacy" } },
        load: { paths: ["/canonical", "/legacy"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: {} },
            load: { paths: ["/canonical", "/legacy"] },
          },
        },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /canonical" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    const result = await loadConfigForInstall(request.request);
    expect(result.config).toEqual({
      plugins: {
        installs: { discord: { source: "npm", installPath: "/legacy" } },
        load: { paths: ["/legacy"] },
      },
    });
  });

  it("rejects recovery when a missing plugin load path is unrelated to the requested plugin", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone", "/other"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: {} },
            load: { paths: ["/gone", "/other"] },
          },
        },
        config: snapshotCfg,
        issues: [{ path: "plugins.load.paths", message: "plugin: plugin path not found: /other" }],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    await expect(loadConfigForInstall(request.request)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
  });

  it("allows official plugin reinstall recovery from source-only runtime shadows", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "npm", installPath: "/bad/discord" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          {
            path: "plugins.entries.discord",
            message:
              "plugin discord: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs, index.js, index.mjs, index.cjs. This is a plugin packaging issue, not a local config problem; update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then. TypeScript source fallback is only supported for source checkouts and local development paths.",
          },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "npm:@openclaw/discord",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("rejects unattributed compiled-runtime recovery issues", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "npm", installPath: "/bad/discord" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          {
            path: "plugins",
            message:
              "plugin: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
          },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "npm:@openclaw/discord",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    await expect(loadConfigForInstall(request.request)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("allows Brave official plugin reinstall recovery from source-only runtime shadows", async () => {
    const snapshotCfg = {
      plugins: { installs: { brave: { source: "clawhub", installPath: "/bad/brave" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { brave: {} } } },
        config: snapshotCfg,
        issues: [
          {
            path: "plugins.entries.brave",
            message:
              "plugin brave: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
          },
          {
            path: "tools.web.search.provider",
            message:
              'web_search provider is not available: brave (install or enable plugin "brave", then run openclaw doctor --fix)',
          },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/brave-plugin",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows explicit repo-checkout bundled-plugin reinstall recovery", async () => {
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: snapshotCfg,
        issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
      }),
    );

    const repoRequest = resolvePluginInstallRequestContext({
      rawSpec: DISCORD_REPO_INSTALL_SPEC,
    });
    if (!repoRequest.ok) {
      throw new Error(repoRequest.error);
    }

    const result = await loadConfigForInstall({
      ...repoRequest.request,
      resolvedPath: bundledPluginRootAt("/tmp/repo", "discord"),
    });
    expect(result.config).toBe(snapshotCfg);
  });

  it("rejects unrelated invalid config even during bundled-plugin reinstall recovery", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ path: "models.default", message: "invalid model ref" }],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("rejects include-backed invalid config instead of flattening it during recovery", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { $include: "./plugins.json" },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
    expect(loadInstalledPluginIndexInstallRecordsMock).not.toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
  });

  it("rejects nested include-backed invalid config instead of flattening it during recovery", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { agents: { list: [{ $include: "./agent.json5" }] } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
    expect(loadInstalledPluginIndexInstallRecordsMock).not.toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
  });

  it("rejects recovery when install policy arrays contain authored env refs", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        deny: ["discord", "keep"],
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: {} },
            deny: ["discord", "${KEEP_PLUGIN}"],
            load: { paths: ["/gone"] },
          },
        },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
    expect(loadInstalledPluginIndexInstallRecordsMock).not.toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
  });

  it("allows recovery when env-backed allow policy already includes the requested plugin", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        allow: ["discord", "keep"],
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: {} },
            allow: ["discord", "${KEEP_PLUGIN}"],
            load: { paths: ["/gone"] },
          },
        },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result.config).toEqual({
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        allow: ["discord", "keep"],
        load: { paths: [] },
      },
    });
  });

  it("rejects non-Discord install requests when config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());

    await expect(
      loadConfigForInstall({
        rawSpec: "alpha",
        normalizedSpec: "alpha",
      }),
    ).rejects.toThrow("Config invalid; run `openclaw doctor --fix` before installing plugins.");
  });

  it("throws when invalid snapshot parsed is empty", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {},
        config: {} as OpenClawConfig,
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("throws when invalid snapshot config file does not exist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot({ exists: false, parsed: {} }));

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });
});
