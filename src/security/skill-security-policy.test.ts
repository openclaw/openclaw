import { describe, expect, it } from "vitest";
import { mapVerdictToAction } from "./policy.js";

describe("mapVerdictToAction", () => {
  it("allows high-confidence benign verdicts for trusted publishers", () => {
    const decision = mapVerdictToAction({
      verdict: "benign",
      confidence: 0.95,
      metadata: {
        formatVersion: 1,
        skillName: "safe",
        version: "1.0.0",
        publisher: { publisherId: "radar", trustLevel: "first_party" },
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceFiles: ["SKILL.md"],
        packageHashSha256: null,
        packaging: { ordering: "lexical", compression: "STORE", timestamp: "2026-01-01T00:00:00.000Z" },
      },
    });
    expect(decision.action).toBe("allow");
  });

  it("upgrades benign verdicts from unknown publishers to warn", () => {
    const decision = mapVerdictToAction({
      verdict: "benign",
      confidence: 0.95,
      metadata: {
        formatVersion: 1,
        skillName: "safe",
        version: "1.0.0",
        publisher: { publisherId: "unknown", trustLevel: "unknown" },
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceFiles: ["SKILL.md"],
        packageHashSha256: null,
        packaging: { ordering: "lexical", compression: "STORE", timestamp: "2026-01-01T00:00:00.000Z" },
      },
    });
    expect(decision.action).toBe("warn");
  });

  it("blocks high-confidence malicious verdicts", () => {
    const decision = mapVerdictToAction({
      verdict: "malicious",
      confidence: 0.99,
    });
    expect(decision.action).toBe("block");
  });

  it("sends unknown verdicts to manual review", () => {
    const decision = mapVerdictToAction({
      verdict: "unknown",
      confidence: 0.2,
    });
    expect(decision.action).toBe("manual_review");
  });
});
