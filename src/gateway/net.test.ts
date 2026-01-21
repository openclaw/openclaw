import { beforeEach, describe, expect, test, vi } from "vitest";

const testTailnetIPv4 = { value: undefined as string | undefined };
const testTailnetIPv6 = { value: undefined as string | undefined };

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => testTailnetIPv6.value,
}));

import { isLocalGatewayAddress } from "./net.js";

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
});
