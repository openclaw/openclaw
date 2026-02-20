import { describe, expect, it } from "vitest";
import { buildNetworkHints, resolveTargets } from "./helpers.js";

describe("resolveTargets — TLS scheme selection", () => {
  it("uses ws:// for local loopback when tls is not configured", () => {
    const targets = resolveTargets({});
    const local = targets.find((t) => t.id === "localLoopback");
    expect(local?.url).toMatch(/^ws:\/\//);
  });

  it("uses wss:// for local loopback when gateway.tls.enabled is true", () => {
    const targets = resolveTargets({ gateway: { tls: { enabled: true } } });
    const local = targets.find((t) => t.id === "localLoopback");
    expect(local?.url).toMatch(/^wss:\/\//);
  });

  it("uses ws:// when gateway.tls.enabled is false", () => {
    const targets = resolveTargets({ gateway: { tls: { enabled: false } } });
    const local = targets.find((t) => t.id === "localLoopback");
    expect(local?.url).toMatch(/^ws:\/\//);
  });
});

describe("buildNetworkHints — TLS scheme selection", () => {
  it("returns ws:// URLs when TLS is not configured", () => {
    const hints = buildNetworkHints({});
    expect(hints.localLoopbackUrl).toMatch(/^ws:\/\//);
  });

  it("returns wss:// URLs when gateway.tls.enabled is true", () => {
    const hints = buildNetworkHints({ gateway: { tls: { enabled: true } } });
    expect(hints.localLoopbackUrl).toMatch(/^wss:\/\//);
    if (hints.localTailnetUrl) {
      expect(hints.localTailnetUrl).toMatch(/^wss:\/\//);
    }
  });
});
