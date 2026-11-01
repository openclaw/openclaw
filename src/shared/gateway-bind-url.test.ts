import { describe, expect, it, vi } from "vitest";
import { resolveGatewayBindUrl } from "./gateway-bind-url.js";

function setup() {
  const pickTailnetHost = vi.fn((): string | null => "100.64.0.1");
  const pickLanHost = vi.fn((): string | null => "192.168.1.2");
  const resolve = (options: Partial<Parameters<typeof resolveGatewayBindUrl>[0]> = {}) =>
    resolveGatewayBindUrl({ scheme: "ws", port: 18789, pickTailnetHost, pickLanHost, ...options });
  const expectNoProbes = () => {
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  };
  return { resolve, pickTailnetHost, pickLanHost, expectNoProbes };
}

describe("shared/gateway-bind-url", () => {
  it.each([undefined, "loopbackish"])("does not probe hosts for bind=%s", (bind) => {
    const { resolve, expectNoProbes } = setup();
    expect(resolve({ bind })).toBeNull();
    expectNoProbes();
  });

  it("resolves custom binds only when custom host is present after trimming", () => {
    const { resolve, expectNoProbes } = setup();
    expect(
      resolve({ bind: "custom", customBindHost: " gateway.local ", scheme: "wss", port: 443 }),
    ).toEqual({ url: "wss://gateway.local:443", source: "gateway.bind=custom" });
    expect(resolve({ bind: "custom", customBindHost: "   " })).toEqual({
      error: "gateway.bind=custom requires gateway.customBindHost.",
    });
    expectNoProbes();
  });

  it("resolves tailnet and lan binds or returns clear errors", () => {
    const { resolve, pickTailnetHost, pickLanHost } = setup();
    expect(resolve({ bind: "tailnet" })).toEqual({
      url: "ws://100.64.0.1:18789",
      source: "gateway.bind=tailnet",
    });
    pickTailnetHost.mockReturnValue(null);
    expect(resolve({ bind: "tailnet" })).toEqual({
      error: "gateway.bind=tailnet set, but no tailnet IP was found.",
    });
    expect(resolve({ bind: "lan", scheme: "wss", port: 8443 })).toEqual({
      url: "wss://192.168.1.2:8443",
      source: "gateway.bind=lan",
    });
    pickLanHost.mockReturnValue(null);
    expect(resolve({ bind: "lan" })).toEqual({
      error: "gateway.bind=lan set, but no private LAN IP was found.",
    });
  });
});
