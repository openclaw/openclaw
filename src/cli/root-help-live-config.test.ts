// Root help live config tests cover root help output derived from live config state.
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
  beforeEach(() => {
    vi.clearAllMocks();
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

describe("root help live config fast path", () => {
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "root-help-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(contents: string): void {
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), contents);
  }

  function writePluginSensitiveConfig(configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });
  }

  it("skips the config load when no config file exists", async () => {
    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("loads the config when the configured file cannot be read", async () => {
    writeConfig(JSON.stringify({ plugins: {} }));
    const readError = Object.assign(new Error("unreadable config"), { code: "EACCES" });
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw readError;
    });
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    try {
      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      readFileSyncSpy.mockRestore();
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("skips the config load for a config whose plugins cannot affect help", async () => {
    writeConfig(JSON.stringify({ plugins: {} }));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("loads the config when plugins.enabled is false", async () => {
    writeConfig(JSON.stringify({ plugins: { enabled: false } }));
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config when the plugins key uses a JSON escape", async () => {
    writeConfig('{"pl\\u0075gins":{"enabled":false}}');
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when a nested include key uses a JSON escape", async () => {
    writeConfig('{"plugins":{"$incl\\u0075de":"./plugins.json"}}');
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from OPENCLAW_HOME", async () => {
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "root-help-openclaw-home-"));
    try {
      fs.mkdirSync(path.join(openclawHome, ".openclaw"), { recursive: true });
      fs.writeFileSync(
        path.join(openclawHome, ".openclaw", "openclaw.json"),
        JSON.stringify({ plugins: { enabled: false } }),
      );
      vi.stubEnv("OPENCLAW_HOME", openclawHome);
      const runtimeConfig = { plugins: { enabled: false } };
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        valid: true,
        sourceConfig: runtimeConfig,
        runtimeConfig,
      });

      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(openclawHome, { recursive: true, force: true });
    }
  });

  it("loads plugin-sensitive config from a relative OPENCLAW_CONFIG_PATH", async () => {
    const configPath = path.join(home, "relative-config", "openclaw.json");
    writePluginSensitiveConfig(configPath);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.relative(process.cwd(), configPath));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a tilde-prefixed OPENCLAW_CONFIG_PATH", async () => {
    const configPath = path.join(home, "tilde-config", "openclaw.json");
    writePluginSensitiveConfig(configPath);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "~/tilde-config/openclaw.json");

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a relative OPENCLAW_STATE_DIR", async () => {
    const stateDir = path.join(home, "relative-state");
    writePluginSensitiveConfig(path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.relative(process.cwd(), stateDir));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a tilde-prefixed OPENCLAW_STATE_DIR", async () => {
    const stateDir = path.join(home, "tilde-state");
    writePluginSensitiveConfig(path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_STATE_DIR", "~/tilde-state");

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when the legacy gateway.env sets a plugin env var (#85396)", async () => {
    fs.mkdirSync(path.join(home, ".config", "openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openclaw", "gateway.env"),
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n",
    );
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when a .env beside OPENCLAW_CONFIG_PATH sets a plugin env var (#85396)", async () => {
    const configDir = path.join(home, "custom");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}");
    fs.writeFileSync(path.join(configDir, ".env"), "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(configDir, "openclaw.json"));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when the raw config uses an include directive", async () => {
    writeConfig('{"$include":"./other.json"}');
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when the raw config is not plain JSON", async () => {
    writeConfig("{ plugins: { /* JSON5 */ } }");
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
