import { beforeEach, describe, expect, test, vi } from "vitest";

const testTailnetIPv4 = { value: undefined as string | undefined };
const testTailnetIPv6 = { value: undefined as string | undefined };

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => testTailnetIPv6.value,
}));

import { isLocalGatewayAddress, resolveGatewayClientIp } from "./net.js";

describe("gateway net", () => {
  beforeEach(() => {
    testTailnetIPv4.value = undefined;
    testTailnetIPv6.value = undefined;
  });

  test("treats loopback as local", () => {
    expect(isLocalGatewayAddress("127.0.0.1")).toBe(true);
    expect(isLocalGatewayAddress("127.0.1.1")).toBe(true);
    expect(isLocalGatewayAddress("::1")).toBe(true);
    expect(isLocalGatewayAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("treats local tailnet IPv4 as local", () => {
    testTailnetIPv4.value = "100.64.0.1";
    expect(isLocalGatewayAddress("100.64.0.1")).toBe(true);
    expect(isLocalGatewayAddress("::ffff:100.64.0.1")).toBe(true);
  });

  test("ignores non-matching tailnet IPv4", () => {
    testTailnetIPv4.value = "100.64.0.1";
    expect(isLocalGatewayAddress("100.64.0.2")).toBe(false);
  });

  test("treats local tailnet IPv6 as local", () => {
    testTailnetIPv6.value = "fd7a:115c:a1e0::123";
    expect(isLocalGatewayAddress("fd7a:115c:a1e0::123")).toBe(true);
  });

  test("uses forwarded-for when remote is a trusted proxy", () => {
    const clientIp = resolveGatewayClientIp({
      remoteAddr: "10.0.0.2",
      forwardedFor: "203.0.113.9, 10.0.0.2",
      trustedProxies: ["10.0.0.2"],
    });
    expect(clientIp).toBe("203.0.113.9");
  });

  test("ignores forwarded-for from untrusted proxies", () => {
    const clientIp = resolveGatewayClientIp({
      remoteAddr: "10.0.0.3",
      forwardedFor: "203.0.113.9",
      trustedProxies: ["10.0.0.2"],
    });
    expect(clientIp).toBe("10.0.0.3");
  });

  test("normalizes trusted proxy IPs and strips forwarded ports", () => {
    const clientIp = resolveGatewayClientIp({
      remoteAddr: "::ffff:10.0.0.2",
      forwardedFor: "203.0.113.9:1234",
      trustedProxies: ["10.0.0.2"],
    });
    expect(clientIp).toBe("203.0.113.9");
  });

  test("falls back to x-real-ip when forwarded-for is missing", () => {
    const clientIp = resolveGatewayClientIp({
      remoteAddr: "10.0.0.2",
      realIp: "203.0.113.10",
      trustedProxies: ["10.0.0.2"],
    });
    expect(clientIp).toBe("203.0.113.10");
  });
});
