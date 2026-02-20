import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import {
  validateUrl,
  isPrivateIpAddress,
  isBlockedHostname,
  SsrFBlockedError,
} from "./ssrf-guard.js";

// ---------------------------------------------------------------------------
// Helper: deterministic mock DNS lookup (no network needed in CI)
// ---------------------------------------------------------------------------

function fakeLookup(address: string, family = 4) {
  const fn = vi.fn<(hostname: string, opts: { all: boolean }) => Promise<LookupAddress[]>>();
  fn.mockResolvedValue([{ address, family }]);
  // Cast to the expected LookupFn signature used by ssrf.ts
  return fn as unknown as typeof import("node:dns/promises").lookup;
}

// ---------------------------------------------------------------------------
// isPrivateIpAddress (re-exported from src/infra/net/ssrf.ts)
// ---------------------------------------------------------------------------

describe("isPrivateIpAddress (re-exported)", () => {
  it.each([
    // IPv4 private ranges
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["169.254.0.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    // CGNAT range (RFC 6598) – missed by original implementation
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    // Public IPs
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["100.63.255.255", false],
    ["100.128.0.1", false],
    // IPv6
    ["::1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::", true],
    // IPv4-mapped IPv6 – was a bypass vector in the original
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:192.168.1.1", true],
    ["::ffff:8.8.8.8", false],
    // Site-local (deprecated but internal) – fec0::/10
    ["fec0::1", true],
  ])("isPrivateIpAddress(%s) = %s", (ip, expected) => {
    expect(isPrivateIpAddress(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isBlockedHostname (re-exported from src/infra/net/ssrf.ts)
// ---------------------------------------------------------------------------

describe("isBlockedHostname (re-exported)", () => {
  it.each([
    ["localhost", true],
    ["metadata.google.internal", true],
    ["evil.localhost", true],
    ["service.local", true],
    ["secret.internal", true],
    ["example.com", false],
    ["api.github.com", false],
  ])("isBlockedHostname(%s) = %s", (hostname, expected) => {
    expect(isBlockedHostname(hostname)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe("validateUrl", () => {
  it("rejects non-HTTP protocols", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("ftp://example.com/file")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("gopher://example.com")).rejects.toThrow(SsrFBlockedError);
  });

  it("rejects invalid URLs", async () => {
    await expect(validateUrl("not-a-url")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("")).rejects.toThrow(SsrFBlockedError);
  });

  it("rejects private IP literals", async () => {
    await expect(validateUrl("http://10.0.0.1/admin")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("http://192.168.1.1/")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("http://127.0.0.1:8080/")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("http://[::1]/")).rejects.toThrow(SsrFBlockedError);
  });

  it("rejects IPv4-mapped IPv6 literals", async () => {
    await expect(validateUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("http://[::ffff:10.0.0.1]/")).rejects.toThrow(SsrFBlockedError);
  });

  it("rejects CGNAT range (100.64.0.0/10)", async () => {
    await expect(validateUrl("http://100.64.0.1/")).rejects.toThrow(SsrFBlockedError);
    await expect(validateUrl("http://100.127.255.255/")).rejects.toThrow(SsrFBlockedError);
  });

  it("rejects cloud metadata endpoints", async () => {
    await expect(validateUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      SsrFBlockedError,
    );
  });

  it("rejects blocked hostnames (localhost, .local, .internal)", async () => {
    const mockLookup = fakeLookup("127.0.0.1");
    await expect(validateUrl("http://localhost/admin", mockLookup)).rejects.toThrow(
      SsrFBlockedError,
    );
    await expect(validateUrl("http://metadata.google.internal/", mockLookup)).rejects.toThrow(
      SsrFBlockedError,
    );
    await expect(validateUrl("http://service.local/", mockLookup)).rejects.toThrow(
      SsrFBlockedError,
    );
  });

  it("rejects hostnames that resolve to private IPs", async () => {
    const mockLookup = fakeLookup("10.0.0.1");
    await expect(validateUrl("https://evil.example.com", mockLookup)).rejects.toThrow(
      SsrFBlockedError,
    );
  });

  it("allows legitimate public URLs (mocked DNS)", async () => {
    const mockLookup = fakeLookup("93.184.216.34");
    await expect(validateUrl("https://example.com", mockLookup)).resolves.toBeUndefined();
  });

  it("allows public IP literals", async () => {
    await expect(validateUrl("http://8.8.8.8/dns-query")).resolves.toBeUndefined();
    await expect(validateUrl("https://1.1.1.1/")).resolves.toBeUndefined();
  });
});
