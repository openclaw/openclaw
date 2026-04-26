import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayFromCliRuntime } from "./gateway-rpc.runtime.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn<(opts: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true })),
  withProgress: vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run()),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.callGateway(opts),
}));

vi.mock("./progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => mocks.withProgress(opts, run),
}));

describe("callGatewayFromCliRuntime timeout parsing", () => {
  beforeEach(() => {
    mocks.callGateway.mockClear();
    mocks.withProgress.mockClear();
  });

  it("preserves the gateway RPC 30s default timeout", async () => {
    await callGatewayFromCliRuntime("health", {});

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: 30_000,
      }),
    );
  });

  it("rejects partial-numeric timeout values before calling Gateway", async () => {
    await expect(callGatewayFromCliRuntime("health", { timeout: "1000ms" })).rejects.toThrow(
      "invalid --timeout: 1000ms",
    );

    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
