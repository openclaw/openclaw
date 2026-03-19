import { describe, it, expect } from "vitest";
import { isIpAllowed, type IpRestrictionConfig } from "./ip-restriction-policy.js";

describe("isIpAllowed", () => {
  it("should allow all IPs when no restrictions configured", () => {
    expect(isIpAllowed("1.2.3.4", {})).toBe(true);
    expect(isIpAllowed("192.168.1.1", {})).toBe(true);
    expect(isIpAllowed("::1", {})).toBe(true);
  });

  it("should allow all IPs when empty lists configured", () => {
    expect(isIpAllowed("1.2.3.4", { ipAllowlist: [], ipBlocklist: [] })).toBe(true);
  });

  it("should fail closed when client IP is undefined", () => {
    expect(isIpAllowed(undefined, { ipAllowlist: ["192.168.1.1"] })).toBe(false);
    expect(isIpAllowed(undefined, { ipBlocklist: ["10.0.0.1"] })).toBe(false);
  });

  describe("allowlist", () => {
    it("should allow IPs in allowlist", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.100", "10.0.0.1"],
      };
      expect(isIpAllowed("192.168.1.100", config)).toBe(true);
      expect(isIpAllowed("10.0.0.1", config)).toBe(true);
    });

    it("should block IPs not in allowlist", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.100"],
      };
      expect(isIpAllowed("192.168.1.101", config)).toBe(false);
      expect(isIpAllowed("10.0.0.1", config)).toBe(false);
    });

    it("should support CIDR notation in allowlist", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.0/24"],
      };
      expect(isIpAllowed("192.168.1.1", config)).toBe(true);
      expect(isIpAllowed("192.168.1.254", config)).toBe(true);
      expect(isIpAllowed("192.168.2.1", config)).toBe(false);
    });

    it("should support IPv6 in allowlist", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["::1", "2001:db8::/32"],
      };
      expect(isIpAllowed("::1", config)).toBe(true);
      expect(isIpAllowed("2001:db8::1", config)).toBe(true);
      expect(isIpAllowed("2001:db9::1", config)).toBe(false);
    });
  });

  describe("blocklist", () => {
    it("should block IPs in blocklist", () => {
      const config: IpRestrictionConfig = {
        ipBlocklist: ["192.168.1.100", "10.0.0.1"],
      };
      expect(isIpAllowed("192.168.1.100", config)).toBe(false);
      expect(isIpAllowed("10.0.0.1", config)).toBe(false);
    });

    it("should allow IPs not in blocklist", () => {
      const config: IpRestrictionConfig = {
        ipBlocklist: ["192.168.1.100"],
      };
      expect(isIpAllowed("192.168.1.101", config)).toBe(true);
      expect(isIpAllowed("10.0.0.1", config)).toBe(true);
    });

    it("should support CIDR notation in blocklist", () => {
      const config: IpRestrictionConfig = {
        ipBlocklist: ["10.0.0.0/8"],
      };
      expect(isIpAllowed("10.0.0.1", config)).toBe(false);
      expect(isIpAllowed("10.255.255.255", config)).toBe(false);
      expect(isIpAllowed("192.168.1.1", config)).toBe(true);
    });
  });

  describe("blocklist precedence", () => {
    it("should block IPs in blocklist even if in allowlist", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.0/24"],
        ipBlocklist: ["192.168.1.100"],
      };
      expect(isIpAllowed("192.168.1.100", config)).toBe(false);
      expect(isIpAllowed("192.168.1.101", config)).toBe(true);
    });

    it("should block entire CIDR range if blocklist is wider", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.100"],
        ipBlocklist: ["192.168.1.0/24"],
      };
      expect(isIpAllowed("192.168.1.100", config)).toBe(false);
      expect(isIpAllowed("192.168.1.101", config)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle invalid IPs gracefully", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["192.168.1.1"],
      };
      expect(isIpAllowed("invalid-ip", config)).toBe(false);
    });

    it("should handle IPv6 addresses", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["::1"],
      };
      expect(isIpAllowed("::1", config)).toBe(true);
      expect(isIpAllowed("::2", config)).toBe(false);
    });

    it("should handle IPv6 with zone IDs", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["fe80::1"],
      };
      expect(isIpAllowed("fe80::1%eth0", config)).toBe(false);
    });

    it("should handle normalized IPv6 addresses", () => {
      const config: IpRestrictionConfig = {
        ipAllowlist: ["0000:0000:0000:0000:0000:0000:0000:0001"],
      };
      expect(isIpAllowed("::1", config)).toBe(true);
    });
  });
});
