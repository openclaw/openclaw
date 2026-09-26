import { describe, expect, expectTypeOf, it } from "vitest";
import { fetchWithSsrFGuard, isLoopbackHost, isPrivateOrLoopbackHost } from "./ssrf-runtime.js";

it("accepts synchronous final dispatch callbacks and rejects asynchronous ones", () => {
  type BeforeRequest = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["beforeRequest"]>;
  expectTypeOf<() => void>().toMatchTypeOf<BeforeRequest>();
  expectTypeOf<() => Promise<void>>().not.toMatchTypeOf<BeforeRequest>();
});

describe("isLoopbackHost", () => {
  it.each(["::", ""])("rejects non-loopback host %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it("stays narrower than the private-or-loopback predicate", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});
