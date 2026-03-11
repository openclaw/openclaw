import { describe, expect, it, vi } from "vitest";
import { readStatusAllTailscale } from "./status-all.js";

describe("readStatusAllTailscale", () => {
  it("skips tailscale status reads when gateway tailscale mode is off", async () => {
    const readStatusJson = vi.fn();

    const result = await readStatusAllTailscale({
      tailscaleMode: "off",
      readStatusJson,
    });

    expect(readStatusJson).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      backendState: null,
      dnsName: null,
      ips: [],
      error: null,
    });
  });

  it("reads and normalizes tailscale status when gateway tailscale mode is enabled", async () => {
    const readStatusJson = vi.fn().mockResolvedValue({
      BackendState: "Running",
      Self: {
        DNSName: "host.tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.1", "  ", 42, "fd7a:115c:a1e0::1"],
      },
    });

    const result = await readStatusAllTailscale({
      tailscaleMode: "serve",
      timeoutMs: 4321,
      readStatusJson,
    });

    expect(readStatusJson).toHaveBeenCalledWith(expect.any(Function), {
      timeoutMs: 4321,
    });
    expect(result).toEqual({
      ok: true,
      backendState: "Running",
      dnsName: "host.tailnet.ts.net",
      ips: ["100.64.0.1", "fd7a:115c:a1e0::1"],
      error: null,
    });
  });
});
