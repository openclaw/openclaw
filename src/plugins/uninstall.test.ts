import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  removePluginFromConfig,
  resolveUninstallChannelConfigKeys,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "./uninstall.js";

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

async function createInstalledNpmPluginFixture(params: {
  baseDir: string;
  pluginId?: string;
}): Promise<{
  pluginId: string;
  extensionsDir: string;
  pluginDir: string;
  config: OpenClawConfig;
}> {
  const pluginId = params.pluginId ?? "my-plugin";
  const extensionsDir = path.join(params.baseDir, "extensions");
  const pluginDir = resolvePluginInstallDir(pluginId, extensionsDir);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");

  return {
    pluginId,
    extensionsDir,
    pluginDir,
    config: {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
        installs: {
          [pluginId]: {
            source: "npm",
            spec: `${pluginId}@1.0.0`,
            installPath: pluginDir,
          },
        },
      },
    },
  };
}

type UninstallResult = Awaited<ReturnType<typeof uninstallPlugin>>;

async function runDeleteInstalledNpmPluginFixture(baseDir: string): Promise<{
  pluginDir: string;
  result: UninstallResult;
}> {
  const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
    baseDir,
  });
  const result = await uninstallPlugin({
    config,
    pluginId,
    deleteFiles: true,
    extensionsDir,
  });
  return { pluginDir, result };
}

function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

function createNpmInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${pluginId}@1.0.0`,
    ...(installPath ? { installPath } : {}),
  };
}

function createPathInstallRecord(
  installPath = "/path/to/plugin",
  sourcePath = installPath,
): PluginInstallRecord {
  return {
    source: "path",
    sourcePath,
    installPath,
  };
}

function createPluginConfig(params: {
  entries?: Record<string, { enabled: boolean }>;
  installs?: Record<string, PluginInstallRecord>;
  allow?: string[];
  deny?: string[];
  enabled?: boolean;
  slots?: PluginConfig["slots"];
  loadPaths?: string[];
  channels?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const plugins: PluginConfig = {};
  if (params.entries) {
    plugins.entries = params.entries;
  }
  if (params.installs) {
    plugins.installs = params.installs;
  }
  if (params.allow) {
    plugins.allow = params.allow;
  }
  if (params.deny) {
    plugins.deny = params.deny;
  }
  if (params.enabled !== undefined) {
    plugins.enabled = params.enabled;
  }
  if (params.slots) {
    plugins.slots = params.slots;
  }
  if (params.loadPaths) {
    plugins.load = { paths: params.loadPaths };
  }
  return {
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
  };
}

function expectRemainingChannels(
  channels: OpenClawConfig["channels"],
  expected: Record<string, unknown> | undefined,
) {
  expect(channels as Record<string, unknown> | undefined).toEqual(expected);
}

function createSinglePluginWithEmptySlotsConfig(): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    slots: {},
  });
}

function createSingleNpmInstallConfig(installPath: string): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    installs: {
      "my-plugin": createNpmInstallRecord("my-plugin", installPath),
    },
  });
}

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

describe("resolveUninstallChannelConfigKeys", () => {
  it("falls back to pluginId when channelIds are unknown", () => {
    expect(resolveUninstallChannelConfigKeys("timbot")).toEqual(["timbot"]);
  });

  it("keeps explicit empty channelIds as remove-nothing", () => {
    expect(resolveUninstallChannelConfigKeys("telegram", { channelIds: [] })).toEqual([]);
  });

  it("filters shared keys and duplicate channel ids", () => {
    expect(
      resolveUninstallChannelConfigKeys("bad-plugin", {
        channelIds: ["defaults", "discord", "discord", "modelByChannel", "slack"],
      }),
    ).toEqual(["discord", "slack"]);
  });
});

describe("removePluginFromConfig", () => {
  it("removes plugin from entries", () => {
    const config = createPluginConfig({
      entries: {
        ...createSinglePluginEntries(),
        "other-plugin": { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual({ "other-plugin": { enabled: true } });
    expect(actions.entry).toBe(true);
  });

  it("removes plugin from installs", () => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createNpmInstallRecord(),
        "other-plugin": createNpmInstallRecord("other-plugin"),
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.installs).toEqual({
      "other-plugin": createNpmInstallRecord("other-plugin"),
    });
    expect(actions.install).toBe(true);
  });

  it("removes plugin from allowlist", () => {
    const config = createPluginConfig({
      allow: ["my-plugin", "other-plugin"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.allow).toEqual(["other-plugin"]);
    expect(actions.allowlist).toBe(true);
  });

  it.each([
    {
      name: "removes linked path from load.paths",
      loadPaths: ["/path/to/plugin", "/other/path"],
      expectedPaths: ["/other/path"],
    },
    {
      name: "cleans up load when removing the only linked path",
      loadPaths: ["/path/to/plugin"],
      expectedPaths: undefined,
    },
  ])("$name", ({ loadPaths, expectedPaths }) => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createPathInstallRecord(),
      },
      loadPaths,
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.load?.paths).toEqual(expectedPaths);
    expect(actions.loadPath).toBe(true);
  });

  it("clears memory slot when uninstalling active memory plugin", () => {
    const config = createPluginConfig({
      entries: {
        "memory-plugin": { enabled: true },
      },
      slots: {
        memory: "memory-plugin",
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "memory-plugin");

    expect(result.plugins?.slots?.memory).toBe("memory-core");
    expect(actions.memorySlot).toBe(true);
  });

  it("does not modify memory slot when uninstalling non-memory plugin", () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      slots: {
        memory: "memory-core",
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.slots?.memory).toBe("memory-core");
    expect(actions.memorySlot).toBe(false);
  });

  it("removes plugins object when uninstall leaves only empty slots", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.slots).toBeUndefined();
  });

  it("cleans up empty slots object", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins).toBeUndefined();
  });

  it.each([
    {
      name: "handles plugin that only exists in entries",
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
      }),
      expectedEntries: undefined,
      expectedInstalls: undefined,
      entryChanged: true,
      installChanged: false,
    },
    {
      name: "handles plugin that only exists in installs",
      config: createPluginConfig({
        installs: {
          "my-plugin": createNpmInstallRecord(),
        },
      }),
      expectedEntries: undefined,
      expectedInstalls: undefined,
      entryChanged: false,
      installChanged: true,
    },
  ])("$name", ({ config, expectedEntries, expectedInstalls, entryChanged, installChanged }) => {
    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual(expectedEntries);
    expect(result.plugins?.installs).toEqual(expectedInstalls);
    expect(actions.entry).toBe(entryChanged);
    expect(actions.install).toBe(installChanged);
  });

  it("cleans up empty plugins object", () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toBeUndefined();
  });

  it("preserves other config values", () => {
    const config = createPluginConfig({
      enabled: true,
      deny: ["denied-plugin"],
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.enabled).toBe(true);
    expect(result.plugins?.deny).toEqual(["denied-plugin"]);
  });

  it("removes channel config for installed extension plugin", () => {
    const config = createPluginConfig({
      entries: {
        timbot: { enabled: true },
      },
      installs: {
        timbot: createNpmInstallRecord("timbot"),
      },
      channels: {
        timbot: { sdkAppId: "123", secretKey: "abc" },
        telegram: { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "timbot");

    expectRemainingChannels(result.channels, {
      telegram: { enabled: true },
    });
    expect(actions.channelConfig).toBe(true);
  });

  it("does not remove channel config for built-in channel without install record", () => {
    const config = createPluginConfig({
      entries: {
        telegram: { enabled: true },
      },
      channels: {
        telegram: { enabled: true },
        discord: { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "telegram");

    expectRemainingChannels(result.channels, {
      telegram: { enabled: true },
      discord: { enabled: true },
    });
    expect(actions.channelConfig).toBe(false);
  });

  it("cleans up channels object when removing the only channel config", () => {
    const config = createPluginConfig({
      entries: {
        timbot: { enabled: true },
      },
      installs: {
        timbot: createNpmInstallRecord("timbot"),
      },
      channels: {
        timbot: { sdkAppId: "123" },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "timbot");

    expect(result.channels).toBeUndefined();
    expect(actions.channelConfig).toBe(true);
  });

  it("does not set channelConfig action when no channel config exists", () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      installs: {
        "my-plugin": createNpmInstallRecord(),
      },
    });

    const { actions } = removePluginFromConfig(config, "my-plugin");

    expect(actions.channelConfig).toBe(false);
  });

  it("does not remove channel config when plugin has no install record", () => {
    const config = createPluginConfig({
      entries: {
        discord: { enabled: true },
      },
      channels: {
        discord: { enabled: true, token: "abc" },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "discord");

    expectRemainingChannels(result.channels, {
      discord: {
        enabled: true,
        token: "abc",
      },
    });
    expect(actions.channelConfig).toBe(false);
  });

  it("removes channel config using explicit channelIds when pluginId differs", () => {
    const config = createPluginConfig({
      entries: {
        "timbot-plugin": { enabled: true },
      },
      installs: {
        "timbot-plugin": createNpmInstallRecord("timbot-plugin"),
      },
      channels: {
        timbot: { sdkAppId: "123" },
        "timbot-v2": { sdkAppId: "456" },
        telegram: { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "timbot-plugin", {
      channelIds: ["timbot", "timbot-v2"],
    });

    expectRemainingChannels(result.channels, {
      telegram: { enabled: true },
    });
    expect(actions.channelConfig).toBe(true);
  });

  it("preserves shared channel keys (defaults, modelByChannel)", () => {
    const config = createPluginConfig({
      entries: {
        timbot: { enabled: true },
      },
      installs: {
        timbot: createNpmInstallRecord("timbot"),
      },
      channels: {
        defaults: { groupPolicy: "opt-in" },
        modelByChannel: { timbot: "gpt-3.5" } as Record<string, string>,
        timbot: { sdkAppId: "123" },
      } as unknown as OpenClawConfig["channels"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "timbot");

    expectRemainingChannels(result.channels, {
      defaults: { groupPolicy: "opt-in" },
      modelByChannel: { timbot: "gpt-3.5" },
    });
    expect(actions.channelConfig).toBe(true);
  });

  it("does not remove shared keys even when passed as channelIds", () => {
    const config = createPluginConfig({
      entries: {
        "bad-plugin": { enabled: true },
      },
      installs: {
        "bad-plugin": createNpmInstallRecord("bad-plugin"),
      },
      channels: {
        defaults: { groupPolicy: "opt-in" },
      } as unknown as OpenClawConfig["channels"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "bad-plugin", {
      channelIds: ["defaults"],
    });

    expectRemainingChannels(result.channels, {
      defaults: { groupPolicy: "opt-in" },
    });
    expect(actions.channelConfig).toBe(false);
  });

  it("skips channel cleanup when channelIds is empty array (non-channel plugin)", () => {
    const config = createPluginConfig({
      entries: {
        telegram: { enabled: true },
      },
      installs: {
        telegram: createNpmInstallRecord("telegram"),
      },
      channels: {
        telegram: { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "telegram", {
      channelIds: [],
    });

    expectRemainingChannels(result.channels, {
      telegram: { enabled: true },
    });
    expect(actions.channelConfig).toBe(false);
  });
});

describe("uninstallPlugin", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns error when plugin not found", async () => {
    const config = createPluginConfig({});

    const result = await uninstallPlugin({
      config,
      pluginId: "nonexistent",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Plugin not found: nonexistent");
    }
  });

  it("removes config entries", async () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      installs: {
        "my-plugin": createNpmInstallRecord(),
      },
    });

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.plugins?.entries).toBeUndefined();
      expect(result.config.plugins?.installs).toBeUndefined();
      expect(result.actions.entry).toBe(true);
      expect(result.actions.install).toBe(true);
    }
  });

  it("deletes directory when deleteFiles is true", async () => {
    const { pluginDir, result } = await runDeleteInstalledNpmPluginFixture(tempDir);

    try {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.actions.directory).toBe(true);
        await expect(fs.access(pluginDir)).rejects.toThrow();
      }
    } finally {
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("preserves directory for linked plugins", async () => {
    const pluginDir = await createPluginDirFixture(tempDir);

    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      installs: {
        "my-plugin": createPathInstallRecord(pluginDir),
      },
      loadPaths: [pluginDir],
    });

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions.directory).toBe(false);
      expect(result.actions.loadPath).toBe(true);
      // Directory should still exist
      await expect(fs.access(pluginDir)).resolves.toBeUndefined();
    }
  });

  it("does not delete directory when deleteFiles is false", async () => {
    const pluginDir = await createPluginDirFixture(tempDir);

    const config = createSingleNpmInstallConfig(pluginDir);

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions.directory).toBe(false);
      // Directory should still exist
      await expect(fs.access(pluginDir)).resolves.toBeUndefined();
    }
  });

  it("succeeds even if directory does not exist", async () => {
    const config = createSingleNpmInstallConfig("/nonexistent/path");

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: true,
    });

    // Should succeed; directory deletion failure is not fatal
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions.directory).toBe(false);
      expect(result.warnings).toEqual([]);
    }
  });

  it("returns a warning when directory deletion fails unexpectedly", async () => {
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const { result } = await runDeleteInstalledNpmPluginFixture(tempDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.actions.directory).toBe(false);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("Failed to remove plugin directory");
      }
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("never deletes arbitrary configured install paths", async () => {
    const outsideDir = path.join(tempDir, "outside-dir");
    const extensionsDir = path.join(tempDir, "extensions");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");

    const config = createSingleNpmInstallConfig(outsideDir);

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions.directory).toBe(false);
      await expect(fs.access(outsideDir)).resolves.toBeUndefined();
    }
  });
});

describe("resolveUninstallDirectoryTarget", () => {
  it("returns null for linked plugins", () => {
    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: {
          source: "path",
          sourcePath: "/tmp/my-plugin",
          installPath: "/tmp/my-plugin",
        },
      }),
    ).toBeNull();
  });

  it("falls back to default path when configured installPath is untrusted", () => {
    const extensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const target = resolveUninstallDirectoryTarget({
      pluginId: "my-plugin",
      hasInstall: true,
      installRecord: {
        source: "npm",
        spec: "my-plugin@1.0.0",
        installPath: "/tmp/not-openclaw-extensions/my-plugin",
      },
      extensionsDir,
    });

    expect(target).toBe(resolvePluginInstallDir("my-plugin", extensionsDir));
  });
});
