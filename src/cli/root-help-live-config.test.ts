// Root help live config tests cover root help output derived from live config state.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadRootHelpRenderOptionsForConfigSensitivePlugins } from "./root-help-live-config.js";

const { configModuleLoadedMock, readConfigFileSnapshotMock } = vi.hoisted(() => ({
  configModuleLoadedMock: vi.fn(),
  readConfigFileSnapshotMock: vi.fn(),
}));

vi.mock("../config/config.js", () => {
  configModuleLoadedMock();
  return {
    readConfigFileSnapshot: readConfigFileSnapshotMock,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("root help live config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses precomputed help without loading config for inert plugin settings", async () => {
    const home = tempDirs.make("openclaw-root-help-inert-");
    const configPath = path.join(home, "profile", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"plugins":{}}\n', "utf8");

    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () => {
        await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
      },
    );

    expect(configModuleLoadedMock).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps injected environments on the snapshot path", async () => {
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
    expect(configModuleLoadedMock).toHaveBeenCalledOnce();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
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
