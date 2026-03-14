import { describe, expect, it } from "vitest";
import {
  validateConfigObjectTolerantWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

/**
 * Tests for tolerant config validation mode (Issue #40317).
 *
 * The gateway must remain resilient when a config file contains keys that are
 * unknown to the current schema version — e.g., keys written by a newer or
 * older version of OpenClaw. In strict mode (CLI operations, config writes)
 * these keys are rejected. In tolerant mode (gateway startup) they are
 * downgraded to non-fatal warnings so the gateway can start up.
 */
describe("config tolerant validation mode", () => {
  // An empty object is valid for OpenClawConfig (all fields are optional).
  const BASE_VALID_CONFIG = {};

  describe("validates correctly in strict mode (existing behavior unchanged)", () => {
    it("succeeds on a minimal valid config", () => {
      const result = validateConfigObjectWithPlugins(BASE_VALID_CONFIG);
      expect(result.ok).toBe(true);
    });

    it("fails when config contains an unknown top-level key", () => {
      const result = validateConfigObjectWithPlugins({
        ...BASE_VALID_CONFIG,
        unknownFutureKey: "some-future-value",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        // The error must reference the unexpected key specifically
        expect(result.issues.some((i) => i.message.toLowerCase().includes("unrecognized"))).toBe(
          true,
        );
      }
    });
  });

  describe("validateConfigObjectTolerantWithPlugins (tolerant mode for gateway startup)", () => {
    it("succeeds on a minimal valid config", () => {
      const result = validateConfigObjectTolerantWithPlugins(BASE_VALID_CONFIG);
      expect(result.ok).toBe(true);
    });

    it("succeeds with a warning when config contains an unknown top-level key", () => {
      const result = validateConfigObjectTolerantWithPlugins({
        ...BASE_VALID_CONFIG,
        unknownFutureKey: "some-future-value",
      });
      // Tolerant mode: unknown top-level keys must NOT block startup
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The unknown key must appear as a non-fatal warning
        const warnTexts = result.warnings.map((w) => w.message.toLowerCase()).join(" ");
        expect(warnTexts).toMatch(/unrecognized/);
      }
    });

    it("still fails hard on real type errors even in tolerant mode", () => {
      const result = validateConfigObjectTolerantWithPlugins({
        ...BASE_VALID_CONFIG,
        // gateway.bind must be a string literal, not a boolean
        gateway: { bind: true },
      });
      // Tolerant mode must NOT silently accept wrong types — fail closed
      expect(result.ok).toBe(false);
    });

    it("preserves valid known fields when an unknown key is also present", () => {
      const result = validateConfigObjectTolerantWithPlugins({
        ...BASE_VALID_CONFIG,
        gateway: { bind: "loopback" },
        unknownFutureKey: "some-future-value",
      });
      // The valid gateway.bind config must survive the tolerant parse
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.gateway?.bind).toBe("loopback");
      }
    });
  });
});
