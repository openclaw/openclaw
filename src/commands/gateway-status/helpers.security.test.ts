import { describe, expect, it } from "vitest";
import { resolveTargets } from "./helpers.js";

function minimalCfg() {
  return {} as Parameters<typeof resolveTargets>[0];
}

describe("CWE-918: gateway-status URL SSRF validation", () => {
  describe("blocked URLs (should be rejected by normalizeWsUrl)", () => {
    it("should reject cloud metadata IP (169.254.169.254)", () => {
      const targets = resolveTargets(minimalCfg(), "ws://169.254.169.254:80");
      expect(targets.find((t) => t.kind === "explicit")).toBeUndefined();
    });

    it("should reject link-local range (169.254.x.x)", () => {
      const targets = resolveTargets(minimalCfg(), "ws://169.254.1.1:18789");
      expect(targets.find((t) => t.kind === "explicit")).toBeUndefined();
    });

    it("should reject metadata.google.internal", () => {
      const targets = resolveTargets(minimalCfg(), "ws://metadata.google.internal:80");
      expect(targets.find((t) => t.kind === "explicit")).toBeUndefined();
    });

    it("should reject *.internal and *.local hostnames", () => {
      const targets1 = resolveTargets(minimalCfg(), "ws://service.internal:18789");
      expect(targets1.find((t) => t.kind === "explicit")).toBeUndefined();

      const targets2 = resolveTargets(minimalCfg(), "ws://gateway.local:18789");
      expect(targets2.find((t) => t.kind === "explicit")).toBeUndefined();
    });

    it("should reject 0.0.0.0", () => {
      const targets = resolveTargets(minimalCfg(), "ws://0.0.0.0:18789");
      expect(targets.find((t) => t.kind === "explicit")).toBeUndefined();
    });
  });

  describe("allowed URLs (legitimate gateway probe targets)", () => {
    it("should allow localhost", () => {
      const targets = resolveTargets(minimalCfg(), "ws://localhost:18789");
      expect(targets.find((t) => t.kind === "explicit")?.url).toBe("ws://localhost:18789");
    });

    it("should allow 127.0.0.1", () => {
      const targets = resolveTargets(minimalCfg(), "ws://127.0.0.1:18789");
      expect(targets.find((t) => t.kind === "explicit")?.url).toBe("ws://127.0.0.1:18789");
    });

    it("should allow private network IPs (LAN gateways)", () => {
      const targets = resolveTargets(minimalCfg(), "ws://192.168.1.100:18789");
      expect(targets.find((t) => t.kind === "explicit")?.url).toBe("ws://192.168.1.100:18789");
    });

    it("should allow public hostnames", () => {
      const targets = resolveTargets(minimalCfg(), "wss://gateway.example.com:18789");
      expect(targets.find((t) => t.kind === "explicit")?.url).toBe(
        "wss://gateway.example.com:18789",
      );
    });

    it("should still reject non-ws protocols", () => {
      const targets = resolveTargets(minimalCfg(), "http://example.com:18789");
      expect(targets.find((t) => t.kind === "explicit")).toBeUndefined();
    });
  });
});
