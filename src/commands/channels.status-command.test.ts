import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn().mockResolvedValue({ channelAccounts: {} }),
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: mocks.callGateway };
});

import { channelsStatusCommand } from "./channels/status.js";

const runtime = createTestRuntime();

describe("channelsStatusCommand", () => {
  beforeEach(() => {
    mocks.callGateway.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("uses strict timeout parsing and falls back to defaults for invalid values", async () => {
    await channelsStatusCommand({ json: true, timeout: "1e3" }, runtime as never);

    const req = mocks.callGateway.mock.calls[0]?.[0] as {
      timeoutMs?: number;
      params?: { timeoutMs?: number };
    };
    expect(req.timeoutMs).toBe(10_000);
    expect(req.params?.timeoutMs).toBe(10_000);
  });

  it("uses default timeout for negative values", async () => {
    await channelsStatusCommand({ json: true, timeout: "-50" }, runtime as never);

    const req = mocks.callGateway.mock.calls[0]?.[0] as {
      timeoutMs?: number;
      params?: { timeoutMs?: number };
    };
    expect(req.timeoutMs).toBe(10_000);
    expect(req.params?.timeoutMs).toBe(10_000);
  });

  it("accepts valid integer timeout values", async () => {
    await channelsStatusCommand({ json: true, timeout: "2500" }, runtime as never);

    const req = mocks.callGateway.mock.calls[0]?.[0] as {
      timeoutMs?: number;
      params?: { timeoutMs?: number };
    };
    expect(req.timeoutMs).toBe(2500);
    expect(req.params?.timeoutMs).toBe(2500);
  });
});
