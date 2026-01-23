import { describe, expect, it, vi } from "vitest";

import {
  ensureGoInstalled,
  ensureTailscaledInstalled,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  enableTailscaleFunnel,
  disableTailscaleFunnel,
  ensureFunnel
} from "./tailscale.js";

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

  it("enableTailscaleServe attempts normal first, then sudo", async () => {
    // 1. First attempt fails
    // 2. Second attempt (sudo) succeeds
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      expect.arrayContaining(["serve", "--bg", "--yes", "3000"]),
      expect.any(Object)
    );

    expect(exec).toHaveBeenNthCalledWith(
      2,
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "serve", "--bg", "--yes", "3000"]),
      expect.any(Object)
    );
  });

  it("enableTailscaleServe does NOT use sudo if first attempt succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["serve", "--bg", "--yes", "3000"]),
      expect.any(Object)
    );
  });

  it("disableTailscaleServe uses fallback", async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ stdout: "" });

    await disableTailscaleServe(exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "serve", "reset"]),
      expect.any(Object)
    );
  });

  it("ensureFunnel uses fallback for enabling", async () => {
    // Mock exec:
    // 1. status (success)
    // 2. enable (fails)
    // 3. enable sudo (success)
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ BackendState: "Running" }) }) // status
      .mockRejectedValueOnce(new Error("failed")) // enable normal
      .mockResolvedValueOnce({ stdout: "" }); // enable sudo

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    const prompt = vi.fn();

    await ensureFunnel(8080, exec as never, runtime, prompt);

    // 1. status
    expect(exec).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      expect.arrayContaining(["funnel", "status", "--json"])
    );

    // 2. enable normal
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "tailscale",
      expect.arrayContaining(["funnel", "--yes", "--bg", "8080"]),
      expect.any(Object)
    );

    // 3. enable sudo
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "funnel", "--yes", "--bg", "8080"]),
      expect.any(Object)
    );
  });
});
