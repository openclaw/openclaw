import { describe, expect, it } from "vitest";
import {
  applyStressScoringToResults,
  calculateInstabilityPenalty,
  calculateStressPenalty,
  composeStressAdjustedScore,
  resolveRegimeSplits,
} from "./stress-scoring.js";

describe("memory stress scoring", () => {
  it("splits results into pre/post regimes using default half split", () => {
    const regimes = resolveRegimeSplits({ entries: [{}, {}, {}, {}] });
    expect(regimes).toEqual(["pre", "pre", "post", "post"]);
  });

  it("supports custom regime split resolver hook", () => {
    const entries = [
      { source: "memory", score: 0.9 },
      { source: "sessions", score: 0.8 },
      { source: "memory", score: 0.7 },
    ];

    const regimes = resolveRegimeSplits({
      entries,
      resolver: ({ entry, defaultRegime }) =>
        entry.source === "sessions" ? "post" : defaultRegime,
    });

    expect(regimes).toEqual(["pre", "post", "post"]);
  });

  it("calculates instability penalty from pre/post mean shift", () => {
    const penalty = calculateInstabilityPenalty({
      preScores: [0.9, 0.7],
      postScores: [0.5, 0.3],
      instabilityWeight: 0.5,
    });

    // means: pre=0.8, post=0.4, shift=0.4 => 0.5*0.4 = 0.2
    expect(penalty).toBeCloseTo(0.2);
  });

  it("calculates stress penalty from stressed score dispersion", () => {
    const penalty = calculateStressPenalty({
      baseScore: 0.8,
      scenarios: [
        { name: "drawdown", multiplier: 0.9 },
        { name: "upside", multiplier: 1.1 },
      ],
      stressWeight: 0.5,
    });

    // all scores = [0.8, 0.72, 0.88], dispersion=0.16 => 0.5*0.16 = 0.08
    expect(penalty).toBeCloseTo(0.08);
  });

  it("composes final score by subtracting penalties from base score", () => {
    const finalScore = composeStressAdjustedScore({
      baseScore: 0.8,
      instabilityPenalty: 0.1,
      stressPenalty: 0.05,
    });

    expect(finalScore).toBeCloseTo(0.65);
  });

  it("is opt-in and leaves scores unchanged by default", () => {
    const input = [{ score: 0.9 }, { score: 0.6 }];

    const scored = applyStressScoringToResults({ results: input });
    expect(scored).toEqual(input);
  });

  it("applies instability + stress penalties when enabled", () => {
    const input = [{ score: 0.9 }, { score: 0.7 }, { score: 0.4 }, { score: 0.2 }];

    const scored = applyStressScoringToResults({
      results: input,
      stressScoring: {
        enabled: true,
        instabilityWeight: 0.5,
        stressWeight: 0.25,
        regimeSplit: { mode: "half" },
        scenarios: [{ name: "drawdown", multiplier: 0.8 }],
      },
    });

    // instability = 0.5 * |mean([0.9,0.7]) - mean([0.4,0.2])|
    //             = 0.5 * |0.8 - 0.3| = 0.25
    expect(scored[0]?.score).toBeCloseTo(0.605); // 0.9 - 0.25 - 0.25*(0.9-0.72)
    expect(scored[1]?.score).toBeCloseTo(0.415); // 0.7 - 0.25 - 0.25*(0.7-0.56)
    expect(scored[2]?.score).toBeCloseTo(0.13); // 0.4 - 0.25 - 0.25*(0.4-0.32)
    expect(scored[3]?.score).toBe(0); // clamped at zero
  });
});
