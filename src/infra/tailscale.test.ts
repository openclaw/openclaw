import { describe, expect, it, vi } from "vitest";

import { ensureGoInstalled, ensureTailscaledInstalled, getTailnetHostname } from "./tailscale.js";

describe("tailscale helpers", () => {
  it("parses DNS name from tailscale status", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.1.1.1"] },
      }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("host.tailnet.ts.net");
  });

  it("falls back to IP when DNS missing", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Self: { TailscaleIPs: ["100.2.2.2"] } }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("100.2.2.2");
  });

  it("ensureGoInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("no go")).mockResolvedValue({}); // brew install go
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureGoInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "go"]);
  });

  it("ensureTailscaledInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValue({});
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureTailscaledInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "tailscale"]);
  });
});
