import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getTailnetHostname = vi.hoisted(() => vi.fn());

vi.mock("../infra/tailscale.js", () => ({ getTailnetHostname }));

import { formatBonjourInstanceName, resolveTailnetDnsHint } from "./server-discovery.js";

describe("formatBonjourInstanceName", () => {
  test("returns OpenClaw for empty input", () => {
    expect(formatBonjourInstanceName("")).toBe("OpenClaw");
    expect(formatBonjourInstanceName("  ")).toBe("OpenClaw");
  });

  test("appends (OpenClaw) suffix for plain names", () => {
    expect(formatBonjourInstanceName("MyMac")).toBe("MyMac (OpenClaw)");
  });

  test("does not append suffix if name already contains openclaw", () => {
    expect(formatBonjourInstanceName("Studio OpenClaw")).toBe("Studio OpenClaw");
  });

  test("truncates long hostnames to fit 63-byte mDNS label limit", () => {
    // Kubernetes-style pod name (55 chars + " (OpenClaw)" = 66 bytes)
    const longPodName = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf";
    const result = formatBonjourInstanceName(longPodName);
    const byteLength = new TextEncoder().encode(result).byteLength;
    expect(byteLength).toBeLessThanOrEqual(63);
    expect(result.length).toBeGreaterThan(0);
  });

  test("preserves names that are exactly 63 bytes", () => {
    // 52 chars + " (OpenClaw)" [11 chars] = 63 bytes exactly
    const name = "a".repeat(52);
    const result = formatBonjourInstanceName(name);
    expect(result).toBe(`${"a".repeat(52)} (OpenClaw)`);
    expect(new TextEncoder().encode(result).byteLength).toBe(63);
  });

  test("handles multi-byte UTF-8 characters without splitting them", () => {
    // Each CJK character is 3 bytes in UTF-8; create a name that would
    // exceed 63 bytes when suffixed.
    const cjkName = "测".repeat(20); // 60 bytes as raw, 70 with suffix
    const result = formatBonjourInstanceName(cjkName);
    const byteLength = new TextEncoder().encode(result).byteLength;
    expect(byteLength).toBeLessThanOrEqual(63);
    // Should not end with a partial UTF-8 sequence
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(result)),
    ).not.toThrow();
  });
});

describe("resolveTailnetDnsHint", () => {
  const prevTailnetDns = { value: undefined as string | undefined };

  beforeEach(() => {
    prevTailnetDns.value = process.env.OPENCLAW_TAILNET_DNS;
    delete process.env.OPENCLAW_TAILNET_DNS;
    getTailnetHostname.mockClear();
  });

  afterEach(() => {
    if (prevTailnetDns.value === undefined) {
      delete process.env.OPENCLAW_TAILNET_DNS;
    } else {
      process.env.OPENCLAW_TAILNET_DNS = prevTailnetDns.value;
    }
  });

  test("returns env hint when disabled", async () => {
    process.env.OPENCLAW_TAILNET_DNS = "studio.tailnet.ts.net.";
    const value = await resolveTailnetDnsHint({ enabled: false });
    expect(value).toBe("studio.tailnet.ts.net");
    expect(getTailnetHostname).not.toHaveBeenCalled();
  });

  test("skips tailscale lookup when disabled", async () => {
    const value = await resolveTailnetDnsHint({ enabled: false });
    expect(value).toBeUndefined();
    expect(getTailnetHostname).not.toHaveBeenCalled();
  });

  test("uses tailscale lookup when enabled", async () => {
    getTailnetHostname.mockResolvedValue("host.tailnet.ts.net");
    const value = await resolveTailnetDnsHint({ enabled: true });
    expect(value).toBe("host.tailnet.ts.net");
    expect(getTailnetHostname).toHaveBeenCalledTimes(1);
  });
});
