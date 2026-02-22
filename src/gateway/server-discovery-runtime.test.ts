import { describe, expect, it, vi } from "vitest";
import { resolveEffectiveMdnsMode } from "./server-discovery-runtime.js";

describe("resolveEffectiveMdnsMode", () => {
  it("keeps full mode on loopback bind", () => {
    const warn = vi.fn();
    const mode = resolveEffectiveMdnsMode({
      gatewayBind: "loopback",
      mdnsMode: "full",
      warn,
    });
    expect(mode).toBe("full");
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to minimal on non-loopback bind when unset", () => {
    const mode = resolveEffectiveMdnsMode({
      gatewayBind: "lan",
      mdnsMode: undefined,
    });
    expect(mode).toBe("minimal");
  });

  it("falls back to minimal for unconfirmed full mode on non-loopback bind", () => {
    const warn = vi.fn();
    const mode = resolveEffectiveMdnsMode({
      gatewayBind: "lan",
      mdnsMode: "full",
      env: {},
      warn,
    });
    expect(mode).toBe("minimal");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows full mode on non-loopback bind when explicitly confirmed", () => {
    const warn = vi.fn();
    const mode = resolveEffectiveMdnsMode({
      gatewayBind: "tailnet",
      mdnsMode: "full",
      env: { OPENCLAW_DISCOVERY_ALLOW_FULL_MDNS: "1" },
      warn,
    });
    expect(mode).toBe("full");
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves off mode on non-loopback bind", () => {
    const warn = vi.fn();
    const mode = resolveEffectiveMdnsMode({
      gatewayBind: "lan",
      mdnsMode: "off",
      warn,
    });
    expect(mode).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });
});
