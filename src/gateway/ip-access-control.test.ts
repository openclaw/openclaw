import { describe, expect, it } from "vitest";
import { checkIpAccess } from "./ip-access-control.js";

describe("checkIpAccess", () => {
  it("allows all traffic when no lists are configured", () => {
    const result = checkIpAccess({ clientIp: "192.168.1.1" });
    expect(result.allowed).toBe(true);
  });

  it("always allows loopback addresses", () => {
    const result = checkIpAccess({
      clientIp: "127.0.0.1",
      blocklist: ["127.0.0.0/8"],
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("loopback");
  });

  it("always allows IPv6 loopback", () => {
    const result = checkIpAccess({
      clientIp: "::1",
      blocklist: ["::1/128"],
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("loopback");
  });

  it("blocks IPs in blocklist", () => {
    const result = checkIpAccess({
      clientIp: "10.0.0.5",
      blocklist: ["10.0.0.0/24"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocklist");
  });

  it("blocklist takes priority over allowlist", () => {
    const result = checkIpAccess({
      clientIp: "10.0.0.5",
      allowlist: ["10.0.0.0/24"],
      blocklist: ["10.0.0.5/32"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocklist");
  });

  it("allows IPs matching allowlist", () => {
    const result = checkIpAccess({
      clientIp: "192.168.1.10",
      allowlist: ["192.168.1.0/24"],
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowlist");
  });

  it("denies IPs not in allowlist when allowlist is set", () => {
    const result = checkIpAccess({
      clientIp: "10.0.0.1",
      allowlist: ["192.168.1.0/24"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("allowlist_miss");
  });

  it("fails closed when clientIp is undefined and lists are configured", () => {
    const result = checkIpAccess({
      clientIp: undefined,
      allowlist: ["192.168.1.0/24"],
    });
    expect(result.allowed).toBe(false);
  });

  it("allows when clientIp is undefined and no lists configured", () => {
    const result = checkIpAccess({ clientIp: undefined });
    expect(result.allowed).toBe(true);
  });

  it("supports exact IP match in allowlist", () => {
    const result = checkIpAccess({
      clientIp: "203.0.113.50",
      allowlist: ["203.0.113.50"],
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowlist");
  });
});
