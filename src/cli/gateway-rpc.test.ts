import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn(async (_opts: unknown) => ({ ok: true }));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

describe("gateway-rpc timeout validation", () => {
  let callGatewayFromCli: typeof import("./gateway-rpc.js").callGatewayFromCli;

  beforeAll(async () => {
    ({ callGatewayFromCli } = await import("./gateway-rpc.js"));
  });

  beforeEach(() => {
    callGateway.mockClear();
    callGateway.mockResolvedValue({ ok: true });
  });

  it.each(["", "nope", "-1"])(
    "rejects invalid timeout %j before calling the gateway",
    async (timeout) => {
      await expect(callGatewayFromCli("health", { timeout, json: true })).rejects.toThrow(
        "--timeout must be a positive integer (milliseconds)",
      );

      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("passes a validated timeout through to callGateway", async () => {
    await callGatewayFromCli("health", { timeout: "2500", json: true });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: 2500,
      }),
    );
  });

  it("uses the CLI default timeout when timeout is omitted", async () => {
    await callGatewayFromCli("health", { json: true });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: 30_000,
      }),
    );
  });
});
