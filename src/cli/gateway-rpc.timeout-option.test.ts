import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    callGateway: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, action: () => Promise<unknown>) => await action(),
}));

const { callGatewayFromCli } = await import("./gateway-rpc.js");

describe("gateway-rpc timeout option", () => {
  beforeEach(() => {
    mocks.callGateway.mockClear();
  });

  it("passes a parsed timeoutMs to callGateway", async () => {
    await callGatewayFromCli("health", { timeout: "1234", json: true }, {});

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
      }),
    );
  });

  it("defaults to 30s when timeout is missing", async () => {
    await callGatewayFromCli("health", { json: true }, {});

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30_000,
      }),
    );
  });

  it("rejects invalid timeout values instead of silently falling back", async () => {
    await expect(callGatewayFromCli("health", { timeout: "nope", json: true }, {})).rejects.toThrow(
      "--timeout must be a positive integer",
    );

    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
