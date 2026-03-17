import { describe, it, expect } from "vitest";
import {
  validateIpRestrictionConfig,
  isIpAllowed,
  createIpRestrictionChecker,
  formatIpRestrictionValidationMessage,
  type IpRestrictionConfig,
} from "./ip-restriction-policy.js";

describe("validateIpRestrictionConfig", () => {
  it("should validate empty config", () => {
    const result = validateIpRestrictionConfig({});
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("should validate config with no restrictions", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: [],
      ipBlocklist: [],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("should reject 0.0.0.0/0 in allowlist", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["0.0.0.0/0"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "ipAllowlist contains 0.0.0.0/0 which allows all IPs - use empty allowlist instead",
      );
    }
  });

  it("should reject ::/0 in allowlist", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["::/0"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "ipAllowlist contains ::/0 which allows all IPs - use empty allowlist instead",
      );
    }
  });

  it("should warn about 0.0.0.0/0 in blocklist", () => {
    const result = validateIpRestrictionConfig({
      ipBlocklist: ["0.0.0.0/0"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "ipBlocklist contains 0.0.0.0/0 which blocks all IPv4 traffic",
    );
  });

  it("should warn about ::/0 in blocklist", () => {
    const result = validateIpRestrictionConfig({
      ipBlocklist: ["::/0"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("ipBlocklist contains ::/0 which blocks all IPv6 traffic");
  });

  it("should warn about duplicate entries in allowlist", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["192.168.1.1", "192.168.1.1"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("ipAllowlist contains duplicate entries");
  });

  it("should warn about duplicate entries in blocklist", () => {
    const result = validateIpRestrictionConfig({
      ipBlocklist: ["10.0.0.1", "10.0.0.1"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("ipBlocklist contains duplicate entries");
  });

  it("should warn about overlapping entries", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["192.168.1.1"],
      ipBlocklist: ["192.168.1.1"],
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("IPs appear in both allowlist and blocklist")),
    ).toBe(true);
  });

  it("should warn if allowlist does not include loopback addresses", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["192.168.1.1"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "ipAllowlist does not include loopback addresses - local connections may be blocked",
    );
  });

  it("should not warn if allowlist includes loopback addresses", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["192.168.1.1", "127.0.0.1"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("loopback"))).toBe(false);
  });

  it("should validate valid CIDR notation", () => {
    const result = validateIpRestrictionConfig({
      ipAllowlist: ["192.168.1.0/24", "10.0.0.0/8"],
      ipBlocklist: ["172.16.0.0/12"],
    });
    expect(result.ok).toBe(true);
  });
});

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

describe("createIpRestrictionChecker", () => {
  it("should create a function that allows all when no restrictions", () => {
    const checker = createIpRestrictionChecker({});
    expect(checker("1.2.3.4")).toBe(true);
    expect(checker("192.168.1.1")).toBe(true);
  });

  it("should create a function that respects allowlist", () => {
    const checker = createIpRestrictionChecker({
      ipAllowlist: ["192.168.1.0/24"],
    });
    expect(checker("192.168.1.1")).toBe(true);
    expect(checker("192.168.2.1")).toBe(false);
  });

  it("should create a function that respects blocklist", () => {
    const checker = createIpRestrictionChecker({
      ipBlocklist: ["10.0.0.1"],
    });
    expect(checker("10.0.0.1")).toBe(false);
    expect(checker("10.0.0.2")).toBe(true);
  });

  it("should create a function where blocklist takes precedence", () => {
    const checker = createIpRestrictionChecker({
      ipAllowlist: ["192.168.1.0/24"],
      ipBlocklist: ["192.168.1.100"],
    });
    expect(checker("192.168.1.100")).toBe(false);
    expect(checker("192.168.1.101")).toBe(true);
  });

  it("should be efficient for multiple checks", () => {
    const checker = createIpRestrictionChecker({
      ipAllowlist: ["192.168.0.0/16"],
    });
    // Pre-compiled checker should be fast for multiple checks
    for (let i = 0; i < 100; i++) {
      expect(checker(`192.168.1.${i}`)).toBe(true);
    }
  });

  it("should handle undefined IP", () => {
    const checker = createIpRestrictionChecker({
      ipAllowlist: ["192.168.1.1"],
    });
    expect(checker(undefined)).toBe(false);
  });

  it("should filter empty strings from configuration", () => {
    const checker = createIpRestrictionChecker({
      ipAllowlist: ["192.168.1.1", "", "  "],
      ipBlocklist: ["", "10.0.0.1"],
    });
    expect(checker("192.168.1.1")).toBe(true);
    expect(checker("10.0.0.1")).toBe(false);
  });
});

describe("formatIpRestrictionValidationMessage", () => {
  it("should format success with no warnings", () => {
    const result = { ok: true as const, warnings: [] };
    const message = formatIpRestrictionValidationMessage(result);
    expect(message).toBe("IP restriction configuration is valid.");
  });

  it("should format success with warnings", () => {
    const result = {
      ok: true as const,
      warnings: ["warning 1", "warning 2"],
    };
    const message = formatIpRestrictionValidationMessage(result);
    expect(message).toContain("WARNINGS:");
    expect(message).toContain("warning 1");
    expect(message).toContain("warning 2");
  });

  it("should format failure with errors and warnings", () => {
    const result = {
      ok: false as const,
      errors: ["error 1", "error 2"],
      warnings: ["warning 1"],
    };
    const message = formatIpRestrictionValidationMessage(result);
    expect(message).toContain("ERRORS:");
    expect(message).toContain("error 1");
    expect(message).toContain("error 2");
    expect(message).toContain("WARNINGS:");
    expect(message).toContain("warning 1");
  });

  it("should format failure with only errors", () => {
    const result = {
      ok: false as const,
      errors: ["error 1"],
      warnings: [],
    };
    const message = formatIpRestrictionValidationMessage(result);
    expect(message).toContain("ERRORS:");
    expect(message).toContain("error 1");
    expect(message).not.toContain("WARNINGS:");
  });
});
