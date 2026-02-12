import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

const { mockWriteFile, mockReadConfigFileSnapshot, mockWriteConfigFile, mockLog, mockError, mockExit } = vi.hoisted(() => {
  return {
    mockWriteFile: vi.fn(),
    mockReadConfigFileSnapshot: vi.fn(),
    mockWriteConfigFile: vi.fn(),
    mockLog: vi.fn(),
    mockError: vi.fn(),
    mockExit: vi.fn(),
  };
});

vi.mock("node:fs/promises", async () => ({
  default: {
    writeFile: mockWriteFile,
  },
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mockReadConfigFileSnapshot,
  writeConfigFile: mockWriteConfigFile,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: mockLog,
    error: mockError,
    exit: mockExit,
  },
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => `INFO: ${msg}`,
  success: (msg: string) => `SUCCESS: ${msg}`,
  warn: (msg: string) => `WARN: ${msg}`,
  danger: (msg: string) => `DANGER: ${msg}`,
}));

import { optimizeTokens } from "./optimize-tokens.js";

describe("optimizeTokens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("exits if config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValue({ valid: false });
    await optimizeTokens();
    expect(mockError).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("creates optimization.json with all settings", async () => {
    const mockConfigPath = "/home/user/.openclaw/openclaw.json";
    mockReadConfigFileSnapshot.mockResolvedValue({
      valid: true,
      path: mockConfigPath,
      config: { agents: { defaults: { models: {} } } },
      parsed: {},
    });

    await optimizeTokens();

    // Check optimization.json write
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    const writeCall1 = mockWriteFile.mock.calls[0];
    expect(writeCall1[0]).toBe(path.join("/home/user/.openclaw", "optimization.json"));
    const writtenConfig = JSON.parse(writeCall1[1]);

    // Pruning
    expect(writtenConfig.agents.defaults.contextPruning.mode).toBe("cache-ttl");

    // Compaction
    expect(writtenConfig.agents.defaults.compaction.mode).toBe("safeguard");

    // Memory
    expect(writtenConfig.agents.defaults.memorySearch.provider).toBe("local");

    // Heartbeat (always 55m)
    expect(writtenConfig.agents.defaults.heartbeat.every).toBe("55m");

    // Models (always includes default)
    expect(writtenConfig.agents.defaults.models["anthropic/claude-opus-4-5"].params.cacheRetention).toBe("long");

    // Check openclaw.json update
    const writeCall2 = mockWriteFile.mock.calls[1];
    expect(writeCall2[0]).toBe(mockConfigPath);
    const writtenMainConfig = JSON.parse(writeCall2[1]);
    expect(writtenMainConfig["$include"]).toEqual(["./optimization.json"]);
  });

  it("appends to existing includes", async () => {
    const mockConfigPath = "/home/user/.openclaw/openclaw.json";
    mockReadConfigFileSnapshot.mockResolvedValue({
      valid: true,
      path: mockConfigPath,
      config: { agents: { defaults: { models: {} } } },
      parsed: { "$include": "./base.json" },
    });

    await optimizeTokens();

    const writeCall2 = mockWriteFile.mock.calls[1];
    const writtenMainConfig = JSON.parse(writeCall2[1]);
    expect(writtenMainConfig["$include"]).toEqual(["./base.json", "./optimization.json"]);
  });

  it("merges existing Anthropic models from config", async () => {
    const mockConfigPath = "/home/user/.openclaw/openclaw.json";
    mockReadConfigFileSnapshot.mockResolvedValue({
      valid: true,
      path: mockConfigPath,
      config: {
        auth: { profiles: {} },
        agents: { defaults: { models: { "anthropic/claude-3": { provider: "anthropic" } } } },
      },
      parsed: {},
    });

    await optimizeTokens();

    const writeCall1 = mockWriteFile.mock.calls[0];
    const writtenConfig = JSON.parse(writeCall1[1]);

    // Check heartbeat (always present)
    expect(writtenConfig.agents.defaults.heartbeat.every).toBe("55m");

    // Check default model
    expect(writtenConfig.agents.defaults.models["anthropic/claude-opus-4-5"].params.cacheRetention).toBe("long");

    // Check merged model
    expect(writtenConfig.agents.defaults.models["anthropic/claude-3"].params.cacheRetention).toBe("long");
  });
});
