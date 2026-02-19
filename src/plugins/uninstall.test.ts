import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  removePluginFromConfig,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "./uninstall.js";

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

function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

function createSinglePluginWithEmptySlotsConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: createSinglePluginEntries(),
      slots: {},
    },
  };
}

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

describe("removePluginFromConfig", () => {
  it("removes plugin from entries", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
          "other-plugin": { enabled: true },
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual({ "other-plugin": { enabled: true } });
    expect(actions.entry).toBe(true);
  });

  it("removes plugin from installs", () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          "my-plugin": { source: "npm", spec: "my-plugin@1.0.0" },
          "other-plugin": { source: "npm", spec: "other-plugin@1.0.0" },
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.installs).toEqual({
      "other-plugin": { source: "npm", spec: "other-plugin@1.0.0" },
    });
    expect(actions.install).toBe(true);
  });

  it("removes plugin from allowlist", () => {
    const config: OpenClawConfig = {
      plugins: {
        allow: ["my-plugin", "other-plugin"],
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.allow).toEqual(["other-plugin"]);
    expect(actions.allowlist).toBe(true);
  });

  it("removes linked path from load.paths", () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "path",
            sourcePath: "/path/to/plugin",
            installPath: "/path/to/plugin",
          },
        },
        load: {
          paths: ["/path/to/plugin", "/other/path"],
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.load?.paths).toEqual(["/other/path"]);
    expect(actions.loadPath).toBe(true);
  });

  it("cleans up load when removing the only linked path", () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "path",
            sourcePath: "/path/to/plugin",
            installPath: "/path/to/plugin",
          },
        },
        load: {
          paths: ["/path/to/plugin"],
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.load).toBeUndefined();
    expect(actions.loadPath).toBe(true);
  });

  it("clears memory slot when uninstalling active memory plugin", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "memory-plugin": { enabled: true },
        },
        slots: {
          memory: "memory-plugin",
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "memory-plugin");

    expect(result.plugins?.slots?.memory).toBe("memory-core");
    expect(actions.memorySlot).toBe(true);
  });

  it("does not modify memory slot when uninstalling non-memory plugin", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
        slots: {
          memory: "memory-core",
        },
      },
    };

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

  it("handles plugin that only exists in entries", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toBeUndefined();
    expect(actions.entry).toBe(true);
    expect(actions.install).toBe(false);
  });

  it("handles plugin that only exists in installs", () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          "my-plugin": { source: "npm", spec: "my-plugin@1.0.0" },
        },
      },
    };

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.installs).toBeUndefined();
    expect(actions.install).toBe(true);
    expect(actions.entry).toBe(false);
  });

  it("cleans up empty plugins object", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
      },
    };

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    // After removing the only entry, entries should be undefined
    expect(result.plugins?.entries).toBeUndefined();
  });

  it("preserves other config values", () => {
    const config: OpenClawConfig = {
      plugins: {
        enabled: true,
        deny: ["denied-plugin"],
        entries: {
          "my-plugin": { enabled: true },
        },
      },
    };

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.enabled).toBe(true);
    expect(result.plugins?.deny).toEqual(["denied-plugin"]);
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
    const config: OpenClawConfig = {};

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
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
        installs: {
          "my-plugin": { source: "npm", spec: "my-plugin@1.0.0" },
        },
      },
    };

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
    const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
      baseDir: tempDir,
    });

    try {
      const result = await uninstallPlugin({
        config,
        pluginId,
        deleteFiles: true,
        extensionsDir,
      });

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

    const config: OpenClawConfig = {
      plugins: {
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
          },
        },
        load: {
          paths: [pluginDir],
        },
      },
    };

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

    const config: OpenClawConfig = {
      plugins: {
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": {
            source: "npm",
            spec: "my-plugin@1.0.0",
            installPath: pluginDir,
          },
        },
      },
    };

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
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
        installs: {
          "my-plugin": {
            source: "npm",
            spec: "my-plugin@1.0.0",
            installPath: "/nonexistent/path",
          },
        },
      },
    };

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
    const { pluginId, extensionsDir, config } = await createInstalledNpmPluginFixture({
      baseDir: tempDir,
    });

    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const result = await uninstallPlugin({
        config,
        pluginId,
        deleteFiles: true,
        extensionsDir,
      });

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

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "my-plugin": { enabled: true },
        },
        installs: {
          "my-plugin": {
            source: "npm",
            spec: "my-plugin@1.0.0",
            installPath: outsideDir,
          },
        },
      },
    };

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
