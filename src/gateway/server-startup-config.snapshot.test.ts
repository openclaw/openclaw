import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const startupMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...mod,
    readConfigFileSnapshot: startupMocks.readConfigFileSnapshot,
    writeConfigFile: startupMocks.writeConfigFile,
  };
});

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => startupMocks.applyPluginAutoEnable(...args),
}));

import { loadGatewayStartupConfigSnapshot } from "./server-startup-config.js";

function baseSnapshot(overrides: Partial<Parameters<typeof buildTestConfigSnapshot>[0]> = {}) {
  const config: OpenClawConfig = {
    gateway: { reload: { debounceMs: 0 } },
  };
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  return buildTestConfigSnapshot({
    path: "/tmp/openclaw-gateway-startup-snapshot-test.json",
    exists: true,
    raw,
    parsed: config,
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
    ...overrides,
  });
}

describe("loadGatewayStartupConfigSnapshot", () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    startupMocks.readConfigFileSnapshot.mockReset();
    startupMocks.writeConfigFile.mockReset();
    startupMocks.applyPluginAutoEnable.mockReset();
    log.info.mockClear();
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null persisted hash when minimalTestGateway skips auto-enable", async () => {
    const snap = baseSnapshot();
    startupMocks.readConfigFileSnapshot.mockResolvedValue(snap);
    startupMocks.applyPluginAutoEnable.mockReturnValue({
      config: snap.config,
      changes: ["would-enable"],
    });

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: true,
      log,
    });

    expect(result.persistedStartupWriteHash).toBeNull();
    expect(startupMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("returns null persisted hash when auto-enable makes no changes", async () => {
    const snap = baseSnapshot();
    startupMocks.readConfigFileSnapshot.mockResolvedValue(snap);
    startupMocks.applyPluginAutoEnable.mockReturnValue({ config: snap.config, changes: [] });

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log,
    });

    expect(result.persistedStartupWriteHash).toBeNull();
    expect(startupMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("returns post-write snapshot hash after persisting auto-enable (feeds config reloader dedupe; #67436)", async () => {
    const before = baseSnapshot();
    const afterWrite = baseSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 } },
        plugins: { entries: { "test-plugin": { enabled: true } } },
      },
    });

    startupMocks.readConfigFileSnapshot
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterWrite);
    startupMocks.writeConfigFile.mockResolvedValue(undefined);
    startupMocks.applyPluginAutoEnable.mockReturnValue({
      config: afterWrite.config,
      changes: ["test-plugin: auto-enabled"],
    });

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log,
    });

    expect(result.snapshot.hash).toBe(afterWrite.hash);
    expect(result.persistedStartupWriteHash).toBe(afterWrite.hash);
    expect(startupMocks.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("returns null persisted hash when the persist write fails", async () => {
    const snap = baseSnapshot();
    startupMocks.readConfigFileSnapshot.mockResolvedValue(snap);
    startupMocks.applyPluginAutoEnable.mockReturnValue({
      config: { ...snap.config },
      changes: ["x"],
    });
    startupMocks.writeConfigFile.mockRejectedValue(new Error("disk full"));

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log,
    });

    expect(result.persistedStartupWriteHash).toBeNull();
    expect(result.snapshot).toBe(snap);
    expect(log.warn).toHaveBeenCalled();
  });
});
