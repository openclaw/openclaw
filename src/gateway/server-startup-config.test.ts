import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

import { prepareGatewayStartupConfig } from "./server-startup-config.js";

function createInvalidSnapshot(
  issue: ConfigFileSnapshot["issues"][number],
): ConfigFileSnapshot {
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
});
