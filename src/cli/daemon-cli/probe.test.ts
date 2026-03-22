import { beforeEach, describe, expect, it, vi } from "vitest";

const probeGateway = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

const { probeGatewayStatus } = await import("./probe.js");

describe("probeGatewayStatus", () => {
  beforeEach(() => {
    probeGateway.mockReset();
  });

  it("rejects cli url overrides that only have daemon-derived auth", async () => {
    const result = await probeGatewayStatus({
      url: "wss://override.example:18790",
      token: "daemon-token",
      timeoutMs: 1_000,
      configPath: "/tmp/openclaw.json",
      requireExplicitAuth: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("gateway url override requires explicit credentials");
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("allows cli url overrides when explicit auth is provided", async () => {
    probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "wss://override.example:18790",
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: {},
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayStatus({
      url: "wss://override.example:18790",
      token: "override-token",
      explicitToken: "override-token",
      timeoutMs: 1_000,
      requireExplicitAuth: true,
    });

    expect(result.ok).toBe(true);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://override.example:18790",
        auth: { token: "override-token", password: undefined },
        detailLevel: "health",
      }),
    );
  });

  it("rejects insecure remote ws overrides before dialing the probe", async () => {
    const result = await probeGatewayStatus({
      url: "ws://override.example:18790",
      token: "override-token",
      explicitToken: "override-token",
      timeoutMs: 1_000,
      configPath: "/tmp/openclaw.json",
      requireExplicitAuth: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SECURITY ERROR");
    expect(result.error).toContain("Source: cli --url");
    expect(probeGateway).not.toHaveBeenCalled();
  });
});
