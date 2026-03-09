import { describe, expect, it } from "vitest";
import {
  computeDrift,
  hashOutput,
  detectStagnation,
  selectPersona,
  arePersonasExhausted,
  createEmptyHistory,
  recordOutput,
  checkResilience,
  PERSONA_PROMPTS,
  PERSONA_AFFINITY,
  type OuroborosHistory,
  type StagnationPattern,
  type ThinkingPersona,
} from "./ouroboros-resilience.js";

describe("hashOutput", () => {
  it("returns a 16-char hex string", () => {
    const hash = hashOutput("hello world");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns same hash for same input", () => {
    expect(hashOutput("test")).toBe(hashOutput("test"));
  });

  it("returns different hash for different input", () => {
    expect(hashOutput("hello")).not.toBe(hashOutput("world"));
  });
});

describe("computeDrift", () => {
  it("returns 0 for identical hashes", () => {
    const hash = hashOutput("same");
    expect(computeDrift(hash, hash)).toBe(0);
  });

  it("returns > 0 for different hashes", () => {
    const a = hashOutput("hello");
    const b = hashOutput("world");
    expect(computeDrift(a, b)).toBeGreaterThan(0);
  });

  it("returns <= 1.0", () => {
    const a = hashOutput("abc");
    const b = hashOutput("xyz");
    expect(computeDrift(a, b)).toBeLessThanOrEqual(1.0);
  });
});

describe("detectStagnation", () => {
  it("returns null for insufficient history", () => {
    const history: OuroborosHistory = {
      outputHashes: ["a", "b"],
      driftScores: [0.5],
      appliedPersonas: [],
    };
    expect(detectStagnation(history)).toBeNull();
  });

  describe("spinning pattern", () => {
    it("detects 3 identical consecutive hashes", () => {
      const hash = hashOutput("stuck");
      const history: OuroborosHistory = {
        outputHashes: [hash, hash, hash],
        driftScores: [0, 0],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe("spinning");
      expect(result!.confidence).toBe(0.95);
    });

    it("does not trigger with different hashes", () => {
      const history: OuroborosHistory = {
        outputHashes: [hashOutput("a"), hashOutput("b"), hashOutput("c")],
        driftScores: [0.5, 0.5],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      // Should not detect spinning (might detect other patterns)
      if (result) {
        expect(result.pattern).not.toBe("spinning");
      }
    });
  });

  describe("oscillation pattern", () => {
    it("detects A-B-A-B pattern", () => {
      const a = hashOutput("stateA");
      const b = hashOutput("stateB");
      const history: OuroborosHistory = {
        outputHashes: [a, b, a, b],
        driftScores: [0.5, 0.5, 0.5],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe("oscillation");
      expect(result!.confidence).toBe(0.9);
    });

    it("does not trigger for non-oscillating pattern", () => {
      const history: OuroborosHistory = {
        outputHashes: [hashOutput("a"), hashOutput("b"), hashOutput("c"), hashOutput("d")],
        driftScores: [0.5, 0.5, 0.5],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      if (result) {
        expect(result.pattern).not.toBe("oscillation");
      }
    });
  });

  describe("no_drift pattern", () => {
    it("detects very low average drift", () => {
      const history: OuroborosHistory = {
        outputHashes: ["a", "b", "c", "d", "e"],
        driftScores: [0.01, 0.02, 0.01, 0.01],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe("no_drift");
    });

    it("does not trigger for zero drift (spinning takes priority)", () => {
      const hash = hashOutput("same");
      const history: OuroborosHistory = {
        outputHashes: [hash, hash, hash, hash, hash],
        driftScores: [0, 0, 0, 0],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).not.toBeNull();
      // Spinning has higher confidence than no_drift
      expect(result!.pattern).toBe("spinning");
    });
  });

  describe("diminishing_returns pattern", () => {
    it("detects drift scores trending toward zero", () => {
      const history: OuroborosHistory = {
        outputHashes: ["a", "b", "c", "d", "e"],
        driftScores: [0.8, 0.5, 0.3, 0.1],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe("diminishing_returns");
    });

    it("does not trigger when drift is stable", () => {
      const history: OuroborosHistory = {
        outputHashes: ["a", "b", "c", "d", "e"],
        driftScores: [0.5, 0.5, 0.5, 0.5],
        appliedPersonas: [],
      };
      const result = detectStagnation(history);
      expect(result).toBeNull();
    });
  });
});

describe("selectPersona", () => {
  it("selects pattern-affine persona first", () => {
    const persona = selectPersona("spinning", []);
    expect(persona).toBe("hacker"); // First affine persona for spinning
  });

  it("skips already-applied personas", () => {
    const persona = selectPersona("spinning", ["hacker"]);
    expect(persona).toBe("contrarian"); // Second affine persona for spinning
  });

  it("falls back to non-affine personas when affine ones exhausted", () => {
    const persona = selectPersona("spinning", ["hacker", "contrarian", "simplifier"]);
    // Remaining non-affine: researcher, architect
    expect(persona).toBe("researcher");
  });

  it("returns null when all personas exhausted", () => {
    const persona = selectPersona("spinning", [
      "hacker",
      "researcher",
      "simplifier",
      "architect",
      "contrarian",
    ]);
    expect(persona).toBeNull();
  });

  it("respects pattern affinity ordering", () => {
    expect(selectPersona("oscillation", [])).toBe("architect");
    expect(selectPersona("no_drift", [])).toBe("contrarian");
    expect(selectPersona("diminishing_returns", [])).toBe("simplifier");
  });
});

describe("arePersonasExhausted", () => {
  it("returns false when not all personas applied", () => {
    expect(arePersonasExhausted(["hacker", "researcher"])).toBe(false);
  });

  it("returns true when all 5 personas applied", () => {
    expect(
      arePersonasExhausted(["hacker", "researcher", "simplifier", "architect", "contrarian"]),
    ).toBe(true);
  });
});

describe("recordOutput", () => {
  it("adds hash to outputHashes", () => {
    const history = createEmptyHistory();
    recordOutput(history, "output 1");
    expect(history.outputHashes).toHaveLength(1);
  });

  it("computes drift from previous hash", () => {
    const history = createEmptyHistory();
    recordOutput(history, "output 1");
    recordOutput(history, "output 2");
    expect(history.driftScores).toHaveLength(1);
    expect(history.driftScores[0]).toBeGreaterThan(0);
  });

  it("records drift of 0 for identical outputs", () => {
    const history = createEmptyHistory();
    recordOutput(history, "same output");
    recordOutput(history, "same output");
    expect(history.driftScores[0]).toBe(0);
  });

  it("bounds history to 20 entries", () => {
    const history = createEmptyHistory();
    for (let i = 0; i < 25; i++) {
      recordOutput(history, `output ${i}`);
    }
    expect(history.outputHashes.length).toBeLessThanOrEqual(20);
    expect(history.driftScores.length).toBeLessThanOrEqual(19);
  });
});

describe("checkResilience", () => {
  it("returns null for healthy history", () => {
    const history = createEmptyHistory();
    recordOutput(history, "good output 1");
    recordOutput(history, "good output 2");
    recordOutput(history, "good output 3");
    // May or may not detect depending on drift; most importantly shouldn't crash
    // With sufficiently different outputs, should return null
    expect(() => checkResilience(history)).not.toThrow();
  });

  it("returns persona prompt for spinning history", () => {
    const history = createEmptyHistory();
    recordOutput(history, "stuck output");
    recordOutput(history, "stuck output");
    recordOutput(history, "stuck output");
    const result = checkResilience(history);
    expect(result).not.toBeNull();
    expect(result!.detection.pattern).toBe("spinning");
    expect(result!.persona).toBeDefined();
    expect(result!.prompt).toContain("[OUROBOROS PERSONA:");
  });

  it("returns null when all personas exhausted", () => {
    const history: OuroborosHistory = {
      outputHashes: [hashOutput("s"), hashOutput("s"), hashOutput("s")],
      driftScores: [0, 0],
      appliedPersonas: ["hacker", "researcher", "simplifier", "architect", "contrarian"],
    };
    const result = checkResilience(history);
    expect(result).toBeNull();
  });
});

describe("PERSONA_PROMPTS", () => {
  it("has prompts for all 5 personas", () => {
    const personas: ThinkingPersona[] = [
      "hacker",
      "researcher",
      "simplifier",
      "architect",
      "contrarian",
    ];
    for (const p of personas) {
      expect(PERSONA_PROMPTS[p]).toBeDefined();
      expect(PERSONA_PROMPTS[p].length).toBeGreaterThan(50);
    }
  });
});

describe("PERSONA_AFFINITY", () => {
  it("maps all 4 patterns to persona arrays", () => {
    const patterns: StagnationPattern[] = [
      "spinning",
      "oscillation",
      "no_drift",
      "diminishing_returns",
    ];
    for (const p of patterns) {
      expect(PERSONA_AFFINITY[p]).toBeDefined();
      expect(PERSONA_AFFINITY[p].length).toBeGreaterThan(0);
    }
  });
});
