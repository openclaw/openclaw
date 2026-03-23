// Authored by: cc (Claude Code) | 2026-03-23
import { describe, expect, it } from "vitest";
import { isControlUiIpAllowed } from "./control-ui-ip-filter.js";

describe("isControlUiIpAllowed", () => {
  // Rule 1 — loopback always allowed
  describe("loopback always permitted", () => {
    it("allows 127.0.0.1 regardless of allowedNetworks", () => {
      expect(
        isControlUiIpAllowed("127.0.0.1", { allowedNetworks: ["10.0.0.0/8"], bindMode: "lan" }),
      ).toBe(true);
    });

    it("allows ::1 regardless of allowedNetworks", () => {
      expect(
        isControlUiIpAllowed("::1", { allowedNetworks: ["10.0.0.0/8"], bindMode: "lan" }),
      ).toBe(true);
    });

    it("allows 127.0.0.1 even with empty allowedNetworks and lan bind", () => {
      expect(isControlUiIpAllowed("127.0.0.1", { allowedNetworks: [], bindMode: "lan" })).toBe(
        true,
      );
    });

    it("allows 127.0.0.1 with no opts", () => {
      expect(isControlUiIpAllowed("127.0.0.1", {})).toBe(true);
    });
  });

  // Rule 2 — explicit allowedNetworks list
  describe("explicit allowedNetworks", () => {
    it("allows ip matching a CIDR in the list", () => {
      expect(
        isControlUiIpAllowed("192.168.1.42", {
          allowedNetworks: ["192.168.1.0/24"],
          bindMode: "lan",
        }),
      ).toBe(true);
    });

    it("denies ip not matching any CIDR", () => {
      expect(
        isControlUiIpAllowed("10.0.0.1", { allowedNetworks: ["192.168.1.0/24"], bindMode: "lan" }),
      ).toBe(false);
    });

    it("allows ip matching second entry in list", () => {
      expect(
        isControlUiIpAllowed("10.0.0.5", {
          allowedNetworks: ["192.168.1.0/24", "10.0.0.0/8"],
          bindMode: "lan",
        }),
      ).toBe(true);
    });

    it("denies when ip is undefined and allowedNetworks is set (fail closed)", () => {
      expect(
        isControlUiIpAllowed(undefined, { allowedNetworks: ["0.0.0.0/0"], bindMode: "lan" }),
      ).toBe(false);
    });

    it("allows IPv6 address matching IPv6 CIDR", () => {
      expect(
        isControlUiIpAllowed("2001:db8::1", {
          allowedNetworks: ["2001:db8::/32"],
          bindMode: "lan",
        }),
      ).toBe(true);
    });

    it("allows IPv6 wildcard ::/0 for any non-loopback IPv6 ip", () => {
      expect(
        isControlUiIpAllowed("2001:db8::1", { allowedNetworks: ["::/0"], bindMode: "lan" }),
      ).toBe(true);
    });

    it("allows 0.0.0.0/0 wildcard for any non-loopback ip", () => {
      expect(
        isControlUiIpAllowed("203.0.113.1", { allowedNetworks: ["0.0.0.0/0"], bindMode: "lan" }),
      ).toBe(true);
    });

    it("allows exact IP match (no CIDR slash required)", () => {
      expect(
        isControlUiIpAllowed("192.168.1.205", {
          allowedNetworks: ["192.168.1.205"],
          bindMode: "lan",
        }),
      ).toBe(true);
    });

    it("denies different ip when entry is an exact IP", () => {
      expect(
        isControlUiIpAllowed("192.168.1.206", {
          allowedNetworks: ["192.168.1.205"],
          bindMode: "lan",
        }),
      ).toBe(false);
    });

    it("allows ip matching mix of exact IPs and CIDRs", () => {
      expect(
        isControlUiIpAllowed("10.0.0.5", {
          allowedNetworks: ["192.168.1.205", "10.0.0.0/8"],
          bindMode: "lan",
        }),
      ).toBe(true);
    });
  });

  // Rule 3 — secure default for lan/custom bind with no allowedNetworks
  describe("secure default for lan/custom bind mode", () => {
    it("denies non-loopback when bind=lan and no allowedNetworks", () => {
      expect(isControlUiIpAllowed("192.168.1.10", { bindMode: "lan" })).toBe(false);
    });

    it("denies undefined ip when bind=lan and no allowedNetworks", () => {
      expect(isControlUiIpAllowed(undefined, { bindMode: "lan" })).toBe(false);
    });

    it("denies non-loopback when bind=custom and no allowedNetworks", () => {
      expect(isControlUiIpAllowed("192.168.1.10", { bindMode: "custom" })).toBe(false);
    });

    it("denies empty allowedNetworks array with lan bind (treated as no allowedNetworks)", () => {
      expect(isControlUiIpAllowed("192.168.1.10", { allowedNetworks: [], bindMode: "lan" })).toBe(
        false,
      );
    });
  });

  // Rule 4 — pass-through for loopback/tailnet/auto/undefined bind modes
  describe("pass-through for other bind modes", () => {
    it("allows non-loopback when bind=loopback (bind handles access)", () => {
      expect(isControlUiIpAllowed("192.168.1.10", { bindMode: "loopback" })).toBe(true);
    });

    it("allows non-loopback when bind=tailnet", () => {
      expect(isControlUiIpAllowed("100.64.0.5", { bindMode: "tailnet" })).toBe(true);
    });

    it("allows non-loopback when bind=auto", () => {
      expect(isControlUiIpAllowed("192.168.1.10", { bindMode: "auto" })).toBe(true);
    });

    it("allows non-loopback when bindMode is undefined", () => {
      expect(isControlUiIpAllowed("192.168.1.10", {})).toBe(true);
    });

    it("denies when bind=loopback but allowedNetworks is set and ip does not match", () => {
      // explicit allowedNetworks always wins over pass-through
      expect(
        isControlUiIpAllowed("10.0.0.1", {
          allowedNetworks: ["192.168.1.0/24"],
          bindMode: "loopback",
        }),
      ).toBe(false);
    });
  });
});
