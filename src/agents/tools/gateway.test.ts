import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { callGatewayTool, resolveGatewayOptions, DEFAULT_GATEWAY_TIMEOUT_MS } from "./gateway.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

describe("gateway tool defaults", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    // Clear env var before each test
    delete process.env.OPENCLAW_GATEWAY_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_GATEWAY_TIMEOUT_MS;
  });

  it("leaves url undefined so callGateway can use config", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
  });

  it("passes through explicit overrides", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://example", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://example",
        token: "t",
        timeoutMs: 5000,
      }),
    );
  });

  it("uses 60 second default timeout instead of 10 seconds", () => {
    const opts = resolveGatewayOptions();
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.timeoutMs).not.toBe(10_000); // Old hardcoded value
  });

  it("respects OPENCLAW_GATEWAY_TIMEOUT_MS environment variable", () => {
    process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = "120000";
    const opts = resolveGatewayOptions();
    expect(opts.timeoutMs).toBe(120_000);
  });

  it("prefers explicit timeoutMs parameter over env var", () => {
    process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = "120000";
    const opts = resolveGatewayOptions({ timeoutMs: 30_000 });
    expect(opts.timeoutMs).toBe(30_000);
  });

  it("handles invalid env var and falls back to default", () => {
    process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = "not-a-number";
    const opts = resolveGatewayOptions();
    expect(opts.timeoutMs).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);
  });

  it("handles empty string env var and falls back to default", () => {
    process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = "";
    const opts = resolveGatewayOptions();
    expect(opts.timeoutMs).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);
  });

  it("respects positive timeout values", () => {
    const opts = resolveGatewayOptions({ timeoutMs: 1 });
    expect(opts.timeoutMs).toBe(1);
  });

  it("converts float timeouts to integers", () => {
    const opts = resolveGatewayOptions({ timeoutMs: 5500.7 });
    expect(opts.timeoutMs).toBe(5500);
  });

  it("rejects zero and negative timeouts, uses minimum of 1", () => {
    const opts0 = resolveGatewayOptions({ timeoutMs: 0 });
    expect(opts0.timeoutMs).toBe(1);

    const optsNeg = resolveGatewayOptions({ timeoutMs: -1000 });
    expect(optsNeg.timeoutMs).toBe(1);
  });

  it("rejects NaN and Infinity values, uses default", () => {
    const optsNaN = resolveGatewayOptions({ timeoutMs: NaN });
    expect(optsNaN.timeoutMs).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);

    const optsInf = resolveGatewayOptions({ timeoutMs: Infinity });
    expect(optsInf.timeoutMs).toBe(DEFAULT_GATEWAY_TIMEOUT_MS);
  });
});
