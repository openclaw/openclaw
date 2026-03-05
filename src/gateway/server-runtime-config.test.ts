import { describe, expect, it } from "vitest";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

// Minimal config stub for tests
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    gateway: {
      bind: "loopback" as const,
      auth: { mode: "token" as const, token: "test-secret" },
      tailscale: { mode: "off" as const },
      ...overrides,
    },
  } as ReturnType<import("../config/config.js").loadConfig>;
}

describe("resolveGatewayRuntimeConfig — Tailscale safe-mode fallback", () => {
  it("starts normally when tailscale=off and bind=loopback", async () => {
    const cfg = makeConfig();
    const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
    expect(result.tailscaleMode).toBe("off");
    expect(result.degradedFeatures).toBeUndefined();
  });

  it("starts normally when tailscale=serve and bind=loopback", async () => {
    const cfg = makeConfig({
      bind: "loopback",
      tailscale: { mode: "serve" },
    });
    const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
    expect(result.tailscaleMode).toBe("serve");
    expect(result.degradedFeatures).toBeUndefined();
  });

  it("degrades gracefully (tailscale→off) when tailscale=serve but bind=lan", async () => {
    // Scenario: Tailscale was disabled externally but config still references it.
    // Previously this threw, causing an unbounded crash loop (263 loops / 3.5h observed).
    const cfg = makeConfig({
      bind: "lan",
      auth: { mode: "token", token: "test-secret" },
      tailscale: { mode: "serve" },
    });
    const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
    expect(result.tailscaleMode).toBe("off");
    expect(result.degradedFeatures).toHaveLength(1);
    expect(result.degradedFeatures![0].feature).toBe("tailscale");
    expect(result.degradedFeatures![0].reason).toMatch(/bind=loopback/);
  });

  it("degrades gracefully (tailscale→off) when tailscale=funnel but bind=lan", async () => {
    const cfg = makeConfig({
      bind: "lan",
      auth: { mode: "token", token: "test-secret" },
      tailscale: { mode: "funnel" },
    });
    const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
    expect(result.tailscaleMode).toBe("off");
    expect(result.degradedFeatures![0].feature).toBe("tailscale");
  });

  it("still throws when tailscale=funnel and auth mode is not password (security boundary)", async () => {
    const cfg = makeConfig({
      bind: "loopback",
      auth: { mode: "token", token: "test-secret" },
      tailscale: { mode: "funnel" },
    });
    await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789 })).rejects.toThrow(
      /tailscale funnel requires gateway auth mode=password/,
    );
  });
});
