// Covers Tailscale whois, Serve, and Funnel helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import * as tailscale from "./tailscale.js";

const {
  getTailnetHostname,
  getTestTailscaleBinaryOverride,
  readTailscaleWhoisIdentity,
  enableTailscaleServe,
  disableTailscaleServe,
  hasTailscaleFunnelRouteForPort,
  tailscaleFunnelStatusCoversPort,
} = tailscale;
const tailscaleBin = "tailscale";

function expectExecCall(
  exec: ReturnType<typeof vi.fn>,
  callNumber: number,
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) {
  const call = exec.mock.calls[callNumber - 1];
  if (!call) {
    throw new Error(`Expected exec call ${callNumber}`);
  }
  expect(call[0]).toBe(command);
  expect(call[1]).toEqual(args);
  if (options) {
    expect(call).toHaveLength(3);
    expect(call[2]).toEqual(options);
  } else {
    expect(call).toHaveLength(2);
  }
}

describe("tailscale helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_TEST_TAILSCALE_BINARY", "NODE_ENV", "VITEST"]);
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "tailscale";
    process.env.VITEST ??= "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

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

  it("parses noisy JSON output from tailscale status", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout:
        'warning: stale state\n{"Self":{"DNSName":"noisy.tailnet.ts.net.","TailscaleIPs":["100.9.9.9"]}}\n',
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("noisy.tailnet.ts.net");
  });

  it("parses noisy JSON output from tailscale whois", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout:
        'warning: stale state\n{"UserProfile":{"LoginName":"operator@example.com","DisplayName":"Operator"}}\n',
    });

    await expect(readTailscaleWhoisIdentity("100.64.0.11", exec)).resolves.toEqual({
      login: "operator@example.com",
      name: "Operator",
    });
  });

  it("caches malformed tailscale whois output on the short error TTL path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "warning: stale state\n{not json}\n" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ UserProfile: { LoginName: "after@example.com" } }),
      });

    await expect(
      readTailscaleWhoisIdentity("100.64.0.12", exec, { errorTtlMs: 1_000 }),
    ).resolves.toBeNull();
    await expect(
      readTailscaleWhoisIdentity("100.64.0.12", exec, { errorTtlMs: 1_000 }),
    ).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);

    await expect(
      readTailscaleWhoisIdentity("100.64.0.12", exec, { errorTtlMs: 1_000 }),
    ).resolves.toEqual({
      login: "after@example.com",
    });

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not cache whois results when the cache expiry would exceed Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ UserProfile: { LoginName: "first@example.com" } }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ UserProfile: { LoginName: "second@example.com" } }),
      });

    await expect(readTailscaleWhoisIdentity("100.64.0.10", exec)).resolves.toEqual({
      login: "first@example.com",
    });
    await expect(readTailscaleWhoisIdentity("100.64.0.10", exec)).resolves.toEqual({
      login: "second@example.com",
    });

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("allows the test binary override in explicit test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/test-tailscale";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBe("/tmp/test-tailscale");
  });

  it("ignores the test binary override outside test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/attacker-tailscale";
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBeNull();
  });

  it("enableTailscaleServe attempts normal first, then sudo", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expectExecCall(exec, 1, tailscaleBin, ["serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
    expectExecCall(exec, 2, "sudo", ["-n", tailscaleBin, "serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("enableTailscaleServe does NOT use sudo if first attempt succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(1);
    expectExecCall(exec, 1, tailscaleBin, ["serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("enableTailscaleServe passes a configured service name", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await enableTailscaleServe(3000, exec as never, "svc:openclaw");

    expect(exec).toHaveBeenCalledTimes(1);
    expectExecCall(
      exec,
      1,
      tailscaleBin,
      ["serve", "--service=svc:openclaw", "--bg", "--yes", "3000"],
      {
        maxBuffer: 200_000,
        timeoutMs: 15_000,
      },
    );
  });

  it("disableTailscaleServe uses fallback", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await disableTailscaleServe(exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expectExecCall(exec, 2, "sudo", ["-n", tailscaleBin, "serve", "reset"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("disableTailscaleServe disables only the configured service name", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await disableTailscaleServe(exec as never, "svc:openclaw");

    expect(exec).toHaveBeenCalledTimes(1);
    expectExecCall(exec, 1, tailscaleBin, ["serve", "clear", "svc:openclaw"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("enableTailscaleServe skips sudo on non-permission errors", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("boom"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toThrow("boom");

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enableTailscaleServe rethrows original error if sudo fails", async () => {
    const originalError = Object.assign(new Error("permission denied"), {
      stderr: "permission denied",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("sudo: a password is required"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toBe(originalError);

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("hasTailscaleFunnelRouteForPort accepts noisy JSON status output", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout:
        'warning: stale state\n{"AllowFunnel":{"device.tailnet.ts.net:443":true},"Web":{"device.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18789"}}}}}\n',
    });

    await expect(hasTailscaleFunnelRouteForPort(18789, exec)).resolves.toBe(true);
  });

  it("hasTailscaleFunnelRouteForPort gracefully handles malformed JSON output", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "warning: stale state\n{not json}\n",
    });

    await expect(hasTailscaleFunnelRouteForPort(18789, exec)).resolves.toBe(false);
  });
});

describe("tailscaleFunnelStatusCoversPort", () => {
  function buildFunnelStatus(handlers: Record<string, { Proxy?: unknown }>) {
    const host = "device.tailnet.ts.net:443";
    return {
      AllowFunnel: { [host]: true },
      Web: {
        [host]: { Handlers: handlers },
      },
    } as Record<string, unknown>;
  }

  it("matches a Funnel route whose Proxy is a full http URL", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a trailing slash", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789/" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a longer path", () => {
    const status = buildFunnelStatus({ "/api": { Proxy: "http://127.0.0.1:18789/api" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the localhost loopback alias", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://localhost:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches an IPv6 loopback Proxy", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://[::1]:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the documented https+insecure target scheme", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://localhost:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches https+insecure with a trailing path", () => {
    const status = buildFunnelStatus({
      "/api": { Proxy: "https+insecure://127.0.0.1:18789/api" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match https+insecure on a non-loopback host", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://10.0.0.5:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("matches a bare port form", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match a Proxy on a different port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:9000" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("does not match a non-loopback host on the right port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://10.0.0.5:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("ignores Web entries whose host is not in AllowFunnel", () => {
    const status = {
      AllowFunnel: { "device.tailnet.ts.net:443": false },
      Web: {
        "device.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
        },
      },
    } as Record<string, unknown>;
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("returns false on an empty status payload", () => {
    expect(tailscaleFunnelStatusCoversPort({}, 18789)).toBe(false);
  });
});
