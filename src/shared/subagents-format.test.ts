/**
 * Tests for subagents-format.ts - particularly resolveTotalTokens robustness
 *
 * Problem: MiniMax provider sometimes returns incomplete usage (missing totalTokens)
 * This test suite verifies graceful handling of edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  resolveTotalTokens,
  resolveIoTokens,
  formatTokenUsageDisplay,
  formatTokenShort,
  formatDurationCompact,
  type TokenUsageLike,
} from "./subagents-format.js";

describe("resolveTotalTokens", () => {
  describe("edge cases", () => {
    it("returns undefined when entry is undefined", () => {
      expect(resolveTotalTokens(undefined)).toBeUndefined();
    });

    it("returns undefined when entry is null", () => {
      // This was the original bug - typeof null === "object", so null passed through
      expect(resolveTotalTokens(null)).toBeUndefined();
    });

    it("returns undefined when entry is not an object", () => {
      expect(resolveTotalTokens("string" as unknown)).toBeUndefined();
      expect(resolveTotalTokens(123 as unknown)).toBeUndefined();
      expect(resolveTotalTokens(true as unknown)).toBeUndefined();
    });

    it("returns totalTokens when present and valid", () => {
      expect(resolveTotalTokens({ totalTokens: 0 })).toBe(0);
      expect(resolveTotalTokens({ totalTokens: 123 })).toBe(123);
      expect(resolveTotalTokens({ totalTokens: 1000 })).toBe(1000);
      expect(resolveTotalTokens({ totalTokens: Infinity })).toBeUndefined(); // Not finite
      expect(resolveTotalTokens({ totalTokens: NaN })).toBeUndefined(); // Not finite
      expect(resolveTotalTokens({ totalTokens: -100 })).toBeUndefined(); // Negative
    });

    it("calculates from input/output when totalTokens missing", () => {
      expect(resolveTotalTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
      expect(resolveTotalTokens({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
      expect(resolveTotalTokens({ inputTokens: 100, outputTokens: 0 })).toBe(100);
    });

    it("prefers totalTokens over calculated input+output", () => {
      expect(resolveTotalTokens({ totalTokens: 200, inputTokens: 100, outputTokens: 50 })).toBe(
        200,
      );
    });

    it("handles empty object gracefully", () => {
      expect(resolveTotalTokens({})).toBeUndefined();
    });
  });

  describe("mock scenarios from production", () => {
    it("handles MiniMax incomplete usage response", () => {
      // Simulates: MiniMax API returns { content: "...", usage: {} }
      const miniMaxResponse = {
        inputTokens: 50,
        outputTokens: 100,
        // totalTokens: undefined/missing
      };
      // Should calculate from input/output instead of crashing
      expect(resolveTotalTokens(miniMaxResponse)).toBe(150);
    });

    it("handles completely empty usage object", () => {
      // Simulates: { usage: {} }
      const emptyUsage = {};
      expect(resolveTotalTokens(emptyUsage)).toBeUndefined();
    });

    it("handles null usage reference", () => {
      // Simulates: usage = null passed to function
      // Before fix: CRASH - Cannot read properties of null
      // After fix: returns undefined gracefully
      expect(resolveTotalTokens(null)).toBeUndefined();
    });
  });

  describe("proxy edge cases", () => {
    it("handles Proxy that throws on property access", () => {
      // Simulates: Object.create(null) or Proxy with throwing getter
      if (typeof Proxy !== "undefined") {
        const throwingProxy = new Proxy(
          {},
          {
            get(target, prop) {
              if (prop === "totalTokens") {
                throw new Error("Proxy throw on totalTokens");
              }
              return undefined;
            },
          },
        );
        // Should return undefined, not throw
        expect(resolveTotalTokens(throwingProxy)).toBeUndefined();
      }
    });
  });
});

describe("resolveIoTokens", () => {
  it("returns undefined when entry is null", () => {
    expect(resolveIoTokens(null)).toBeUndefined();
  });

  it("returns undefined when entry is undefined", () => {
    expect(resolveIoTokens(undefined)).toBeUndefined();
  });

  it("calculates io tokens correctly", () => {
    const result = resolveIoTokens({ inputTokens: 100, outputTokens: 50 });
    expect(result).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("returns undefined when all zeros", () => {
    expect(resolveIoTokens({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

describe("formatTokenUsageDisplay", () => {
  it("returns empty string when entry is null", () => {
    // Before fix: CRASH
    // After fix: returns ""
    expect(formatTokenUsageDisplay(null)).toBe("");
  });

  it("returns empty string when entry is undefined", () => {
    expect(formatTokenUsageDisplay(undefined)).toBe("");
  });

  it("formats usage correctly when available", () => {
    const result = formatTokenUsageDisplay({
      totalTokens: 1000,
      inputTokens: 600,
      outputTokens: 400,
    });
    expect(result).toContain("1k");
  });

  it("handles MiniMax partial usage", () => {
    // Simulates: MiniMax returns only inputTokens
    const miniMaxPartial = {
      inputTokens: 100,
      // outputTokens and totalTokens missing
    };
    // Should not crash, show partial info
    const result = formatTokenUsageDisplay(miniMaxPartial);
    expect(result).toContain("tokens");
  });
});

describe("helper functions", () => {
  describe("formatTokenShort", () => {
    it("handles undefined gracefully", () => {
      expect(formatTokenShort(undefined)).toBeUndefined();
    });

    it("formats numbers correctly", () => {
      expect(formatTokenShort(500)).toBe("500");
      expect(formatTokenShort(1500)).toBe("1.5k");
      expect(formatTokenShort(10000)).toBe("10k");
      expect(formatTokenShort(1500000)).toBe("1.5m");
    });

    it("handles zero and negative", () => {
      expect(formatTokenShort(0)).toBeUndefined();
      expect(formatTokenShort(-100)).toBeUndefined();
    });
  });

  describe("formatDurationCompact", () => {
    it("handles undefined", () => {
      expect(formatDurationCompact(undefined)).toBe("n/a");
    });

    it("formats correctly", () => {
      expect(formatDurationCompact(60000)).toBe("1m");
      expect(formatDurationCompact(3600000)).toBe("1h");
      expect(formatDurationCompact(90000000)).toBe("1d1h");
    });
  });
});

// Re-export for type checking
export type { TokenUsageLike };

// Mock testing utilities for production simulation
export function mockMiniMaxPartialUsage(): TokenUsageLike {
  return {
    inputTokens: Math.floor(Math.random() * 500) + 50,
    // Simulates MiniMax behavior: outputTokens sometimes missing
  };
}

export function mockCompleteUsage(): TokenUsageLike {
  return {
    totalTokens: 1234,
    inputTokens: 800,
    outputTokens: 434,
  };
}
