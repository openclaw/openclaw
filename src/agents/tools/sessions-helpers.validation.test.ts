/**
 * Unit tests for A2A security validation functions in sessions-helpers.ts
 */

import { describe, it, expect } from "vitest";
import {
  validateAgentId,
  validateSkillName,
  validateAgentSessionKey,
  validateInputSize,
  boundConfidence,
  MAX_A2A_INPUT_SIZE,
} from "./sessions-helpers.js";

describe("validateAgentId", () => {
  it("accepts valid agent IDs", () => {
    expect(validateAgentId("metis")).toBe("metis");
    expect(validateAgentId("rca-agent")).toBe("rca-agent");
    expect(validateAgentId("test_agent")).toBe("test_agent");
    expect(validateAgentId("agent123")).toBe("agent123");
  });

  it("normalizes to lowercase", () => {
    expect(validateAgentId("MyAgent")).toBe("myagent");
    expect(validateAgentId("TEST-AGENT")).toBe("test-agent");
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateAgentId("../../etc/passwd")).toThrow();
    expect(() => validateAgentId("./relative")).toThrow();
    expect(() => validateAgentId("../parent")).toThrow();
  });

  it("rejects special characters", () => {
    expect(() => validateAgentId("agent@name")).toThrow();
    expect(() => validateAgentId("agent name")).toThrow();
    expect(() => validateAgentId("agent!name")).toThrow();
    expect(() => validateAgentId("agent#name")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => validateAgentId("")).toThrow("empty");
    expect(() => validateAgentId("   ")).toThrow("empty");
  });

  it("rejects overly long IDs", () => {
    const longId = "a".repeat(100);
    expect(() => validateAgentId(longId)).toThrow("too long");
  });

  it("handles null bytes", () => {
    expect(() => validateAgentId("agent\x00name")).toThrow();
  });
});

describe("validateSkillName", () => {
  it("accepts valid skill names", () => {
    expect(validateSkillName("critique")).toBe("critique");
    expect(validateSkillName("analyze-data")).toBe("analyze-data");
    expect(validateSkillName("test_skill")).toBe("test_skill");
    expect(validateSkillName("Skill123")).toBe("Skill123");
  });

  it("preserves case (unlike agent ID)", () => {
    expect(validateSkillName("MySkill")).toBe("MySkill");
    expect(validateSkillName("UPPERCASE")).toBe("UPPERCASE");
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateSkillName("../../etc/passwd")).toThrow();
    expect(() => validateSkillName("./relative")).toThrow();
    expect(() => validateSkillName("rm -rf /")).toThrow();
  });

  it("rejects special characters", () => {
    expect(() => validateSkillName("skill@name")).toThrow();
    expect(() => validateSkillName("skill name")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => validateSkillName("")).toThrow("empty");
    expect(() => validateSkillName("   ")).toThrow("empty");
  });

  it("rejects overly long names", () => {
    const longName = "a".repeat(150);
    expect(() => validateSkillName(longName)).toThrow("too long");
  });
});

describe("validateAgentSessionKey", () => {
  it("accepts valid session keys", () => {
    expect(validateAgentSessionKey("agent:metis:main")).toBe("agent:metis:main");
    expect(validateAgentSessionKey("agent:rca-agent:label")).toBe("agent:rca-agent:label");
    expect(validateAgentSessionKey("agent:test_123:work")).toBe("agent:test_123:work");
  });

  it("rejects malformed session keys", () => {
    expect(() => validateAgentSessionKey("metis")).toThrow();
    expect(() => validateAgentSessionKey("agent:metis")).toThrow();
    expect(() => validateAgentSessionKey("agent:metis:")).toThrow();
    expect(() => validateAgentSessionKey(":metis:main")).toThrow();
  });

  it("rejects path traversal in session keys", () => {
    expect(() => validateAgentSessionKey("agent:../../etc:main")).toThrow();
    expect(() => validateAgentSessionKey("agent:metis:../../../etc")).toThrow();
    expect(() => validateAgentSessionKey("agent:../..:main")).toThrow();
  });

  it("rejects uppercase letters (enforced lowercase)", () => {
    expect(() => validateAgentSessionKey("agent:Metis:main")).toThrow();
    expect(() => validateAgentSessionKey("agent:metis:Main")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => validateAgentSessionKey("")).toThrow("empty");
    expect(() => validateAgentSessionKey("   ")).toThrow("empty");
  });
});

describe("validateInputSize", () => {
  it("accepts small inputs", () => {
    expect(() => validateInputSize({ foo: "bar" })).not.toThrow();
    expect(() => validateInputSize([1, 2, 3])).not.toThrow();
    expect(() => validateInputSize("small string")).not.toThrow();
  });

  it("rejects oversized inputs", () => {
    const largeInput = { data: "x".repeat(MAX_A2A_INPUT_SIZE * 2) };
    expect(() => validateInputSize(largeInput)).toThrow("too large");
  });

  it("respects custom max size", () => {
    const input = { data: "x".repeat(100) };
    expect(() => validateInputSize(input, 50)).toThrow("too large");
    expect(() => validateInputSize(input, 200)).not.toThrow();
  });

  it("handles edge case at limit", () => {
    // Exact size at limit should pass
    const input = { data: "x".repeat(1000) };
    const size = JSON.stringify(input).length;
    expect(() => validateInputSize(input, size)).not.toThrow();
    expect(() => validateInputSize(input, size - 1)).toThrow("too large");
  });
});

describe("boundConfidence", () => {
  it("returns 0.5 for non-numeric values", () => {
    expect(boundConfidence("string")).toBe(0.5);
    expect(boundConfidence(undefined)).toBe(0.5);
    expect(boundConfidence(null)).toBe(0.5);
    expect(boundConfidence({})).toBe(0.5);
    expect(boundConfidence([1, 2, 3])).toBe(0.5);
  });

  it("returns 0.5 for NaN and Infinity", () => {
    expect(boundConfidence(NaN)).toBe(0.5);
    expect(boundConfidence(Infinity)).toBe(0.5);
    expect(boundConfidence(-Infinity)).toBe(0.5);
  });

  it("clamps negative values to 0", () => {
    expect(boundConfidence(-5)).toBe(0);
    expect(boundConfidence(-0.5)).toBe(0);
    expect(boundConfidence(-100)).toBe(0);
  });

  it("clamps values > 1 to 1", () => {
    expect(boundConfidence(1.5)).toBe(1);
    expect(boundConfidence(2)).toBe(1);
    expect(boundConfidence(100)).toBe(1);
  });

  it("preserves valid values in [0, 1]", () => {
    expect(boundConfidence(0)).toBe(0);
    expect(boundConfidence(0.5)).toBe(0.5);
    expect(boundConfidence(0.85)).toBe(0.85);
    expect(boundConfidence(1)).toBe(1);
  });

  it("handles edge cases", () => {
    // Very small positive number
    expect(boundConfidence(0.0000001)).toBeCloseTo(0.0000001);
    // Number that's almost 1
    expect(boundConfidence(0.9999999)).toBeCloseTo(0.9999999);
    // Negative zero is valid (equals 0)
    expect(boundConfidence(-0)).toBe(0);
  });
});
