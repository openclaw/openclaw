import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
  migrateLegacyConfig:
    vi.fn<
      (parsed: unknown) => { config: ConfigFileSnapshot["config"] | null; changes: string[] }
    >(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    migrateLegacyConfig: mocks.migrateLegacyConfig,
  };
});

import { prepareGatewayStartupConfig } from "./server-startup-config.js";

function createInvalidSnapshot(issue: ConfigFileSnapshot["issues"][number]): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: false,
    config: {},
    issues: [issue],
    warnings: [],
    legacyIssues: [],
  };
}

describe("prepareGatewayStartupConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.migrateLegacyConfig.mockReset();
  });

  it("sanitizes validation issue path and message in startup error output", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(
      createInvalidSnapshot({
        path: "gateway.auth.token\u001b[31m\nx",
        message: "bad\u001b[32m value\toops",
      }),
    );

    const run = prepareGatewayStartupConfig({
      info: vi.fn(),
      warn: vi.fn(),
    });
    await expect(run).rejects.toThrow(/Invalid config at/);

    await run.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("gateway.auth.token\\nx: bad value\\toops");
      expect(message).not.toContain("\u001b");
    });
  });

  it("continues validation when legacy migration yields no config and surfaces detailed issues", async () => {
    mocks.migrateLegacyConfig.mockReturnValue({ config: null, changes: [] });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: { heartbeat: 15 },
      resolved: {},
      valid: false,
      config: {},
      issues: [
        {
          path: "heartbeat",
          message: "Unknown key",
        },
      ],
      warnings: [],
      legacyIssues: [
        {
          path: "heartbeat",
          message: "Legacy key",
        },
      ],
    });

    const warn = vi.fn();
    await expect(
      prepareGatewayStartupConfig({
        info: vi.fn(),
        warn,
      }),
    ).rejects.toThrow(/Invalid config at \/tmp\/openclaw\.json\.\nheartbeat: Unknown key/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("legacy config entries detected but no auto-migration changes"),
    );
  });
});
