import { describe, expect, it } from "vitest";
import {
  detectPrototypePollution,
  freezeSafeGlobals,
  snapshotPrototypes,
} from "./globals-freeze.js";

describe("snapshotPrototypes", () => {
  it("captures current prototype property names", () => {
    const snapshot = snapshotPrototypes();
    expect(snapshot.has("Object.prototype")).toBe(true);
    expect(snapshot.has("Array.prototype")).toBe(true);
    expect(snapshot.get("Object.prototype")!.has("toString")).toBe(true);
    expect(snapshot.get("Array.prototype")!.has("push")).toBe(true);
  });
});

describe("detectPrototypePollution", () => {
  it("returns empty array for clean prototypes", () => {
    const snapshot = snapshotPrototypes();
    const violations = detectPrototypePollution(snapshot);
    expect(violations).toHaveLength(0);
  });

  it("detects added properties on Object.prototype", () => {
    const snapshot = snapshotPrototypes();

    // Simulate pollution — intentionally modifying prototype for security test
    const desc = Object.getOwnPropertyDescriptor(Object.prototype, "__test_pollution__");
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, "__test_pollution__", {
      value: "evil",
      configurable: true,
    });

    try {
      const violations = detectPrototypePollution(snapshot);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("Object.prototype.__test_pollution__");
    } finally {
      // Cleanup — restore original state
      if (desc) {
        // eslint-disable-next-line no-extend-native
        Object.defineProperty(Object.prototype, "__test_pollution__", desc);
      } else {
        delete (Object.prototype as Record<string, unknown>).__test_pollution__;
      }
    }
  });
});

describe("freezeSafeGlobals", () => {
  it("freezes JSON", () => {
    freezeSafeGlobals();
    expect(Object.isFrozen(JSON)).toBe(true);
  });

  it("freezes Math", () => {
    expect(Object.isFrozen(Math)).toBe(true);
  });

  it("freezes Reflect", () => {
    expect(Object.isFrozen(Reflect)).toBe(true);
  });
});
