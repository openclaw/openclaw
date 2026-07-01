import { describe, expect, it } from "vitest";
import {
  buildDurableSubagentOrchestrationGuidance,
  normalizeDurableOrchestrationPolicy,
  resolveDurableOrchestrationPolicy,
} from "./orchestration-policy.js";

describe("durable orchestration policy", () => {
  it("defaults unknown values to auto", () => {
    expect(normalizeDurableOrchestrationPolicy(undefined)).toBe("auto");
    expect(normalizeDurableOrchestrationPolicy("nope")).toBe("auto");
    expect(
      resolveDurableOrchestrationPolicy({ OPENCLAW_DURABLE_ORCHESTRATION_POLICY: "solo_first" }),
    ).toBe("solo_first");
  });

  it("keeps auto guidance balanced between direct work and fan-out", () => {
    const guidance = buildDurableSubagentOrchestrationGuidance({
      policy: "auto",
      hasSessionsSpawn: true,
      hasSubagents: true,
      hasSessionsYield: true,
    });

    expect(guidance).toContain("start directly when the current context is enough");
    expect(guidance).toContain("parallelism");
    expect(guidance).toContain("sessions_yield");
    expect(guidance).toContain("not wait loops");
  });

  it("supports solo-first guidance for stronger models and larger context windows", () => {
    const guidance = buildDurableSubagentOrchestrationGuidance({
      policy: "solo_first",
      hasSessionsSpawn: true,
      hasSubagents: false,
      hasSessionsYield: false,
    });

    expect(guidance).toContain("prefer doing the work directly");
    expect(guidance).toContain("spawn only");
  });
});
