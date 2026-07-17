// Tests for Gateway startup main agent recovery.
import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";

// Mock at the top level
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
}));

vi.mock("../config/io.runtime.js", () => ({
  writeConfigFile: vi.fn(),
}));

describe("Gateway startup main agent recovery", () => {
  it("detects and recovers missing main agent during config snapshot loading", async () => {
    const { readConfigFileSnapshotWithPluginMetadata } = await import("../config/io.js");
    const { writeConfigFile } = await import("../config/io.runtime.js");

    const mockSnapshot: ConfigFileSnapshot = {
      exists: true,
      valid: true,
      path: "/tmp/test/openclaw.json",
      hash: "test-hash",
      config: {
        agents: {
          list: [
            {
              id: "secondary",
              name: "Secondary Agent",
            },
          ],
        },
      },
      sourceConfig: {
        agents: {
          list: [
            {
              id: "secondary",
              name: "Secondary Agent",
            },
          ],
        },
      },
      legacyIssues: [],
      runtimeConfig: undefined,
    };

    vi.mocked(readConfigFileSnapshotWithPluginMetadata).mockResolvedValue({
      snapshot: mockSnapshot,
      pluginMetadataSnapshot: undefined,
    });

    vi.mocked(writeConfigFile).mockResolvedValue(undefined);

    const { loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js");

    const logMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log: logMock,
    });

    // Verify that a warning was logged about missing main agent
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing required "main" agent entry'),
    );

    // Verify that config was written with recovered main agent
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0][0];
    expect(writtenConfig.agents?.list).toHaveLength(2);
    expect(writtenConfig.agents?.list[0]).toMatchObject({
      id: "main",
      name: "Main",
    });

    // Verify that an info message was logged about recovery
    expect(logMock.info).toHaveBeenCalledWith(
      expect.stringContaining('Recovered "main" agent entry'),
    );

    // Verify that the returned snapshot has the recovered config
    expect(result.snapshot.config.agents?.list).toHaveLength(2);
    expect(result.snapshot.config.agents?.list[0]).toMatchObject({
      id: "main",
      name: "Main",
    });

    // Verify that wroteConfig is true since write succeeded
    expect(result.wroteConfig).toBe(true);
  });
});
