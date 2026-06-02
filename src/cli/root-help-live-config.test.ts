import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRootHelpRenderOptionsForConfigSensitivePlugins } from "./root-help-live-config.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

describe("root help live config", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("skips the heavy config module when no plugin-sensitive config file exists", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-help-"));
    process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, "missing-openclaw.json");
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    await expect(
      loadRootHelpRenderOptionsForConfigSensitivePlugins(process.env),
    ).resolves.toBeNull();

    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("checks live config when plugin-sensitive env only exists in legacy gateway env", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-help-"));
    try {
      const cwdDir = path.join(tempDir, "cwd");
      const gatewayEnvPath = path.join(tempDir, ".config", "openclaw", "gateway.env");
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(path.dirname(gatewayEnvPath), { recursive: true });
      fs.writeFileSync(gatewayEnvPath, "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n", "utf8");
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      process.env.HOME = tempDir;
      process.env.OPENCLAW_STATE_DIR = path.join(tempDir, ".openclaw");
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        valid: true,
        sourceConfig: {},
        runtimeConfig: {},
      });

      await expect(
        loadRootHelpRenderOptionsForConfigSensitivePlugins(process.env),
      ).resolves.toBeNull();

      expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores legacy gateway env during precheck for an explicit custom state dir", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-help-"));
    try {
      const cwdDir = path.join(tempDir, "cwd");
      const gatewayEnvPath = path.join(tempDir, ".config", "openclaw", "gateway.env");
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(path.dirname(gatewayEnvPath), { recursive: true });
      fs.writeFileSync(gatewayEnvPath, "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n", "utf8");
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      process.env.HOME = tempDir;
      process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "custom-state");
      process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, "missing-openclaw.json");
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

      await expect(
        loadRootHelpRenderOptionsForConfigSensitivePlugins(process.env),
      ).resolves.toBeNull();

      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks live config when plugin-sensitive env exists beside an explicit config path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-help-"));
    try {
      const cwdDir = path.join(tempDir, "cwd");
      const configPath = path.join(tempDir, "custom", "missing-openclaw.json");
      const configDirEnvPath = path.join(path.dirname(configPath), ".env");
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(path.dirname(configDirEnvPath), { recursive: true });
      fs.writeFileSync(configDirEnvPath, "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n", "utf8");
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      process.env.HOME = tempDir;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        valid: true,
        sourceConfig: {},
        runtimeConfig: {},
      });

      await expect(
        loadRootHelpRenderOptionsForConfigSensitivePlugins(process.env),
      ).resolves.toBeNull();

      expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses precomputed help when plugin-sensitive config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      runtimeConfig: {},
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins({})).resolves.toBeNull();
  });

  it("uses snapshot runtime config when plugin config affects help", async () => {
    const runtimeConfig = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
      },
    };
    const env = {};
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins(env)).resolves.toEqual({
      config: runtimeConfig,
      env,
    });
  });
});
