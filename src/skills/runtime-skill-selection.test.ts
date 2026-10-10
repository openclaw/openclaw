import { describe, expect, it } from "vitest";
import { buildRuntimeSkillSelectionMarker } from "./runtime-skill-selection.js";

describe("runtime skill selection marker", () => {
  it("records only observed runtime skill use metadata", () => {
    expect(
      buildRuntimeSkillSelectionMarker({
        agentId: "main",
        sessionKey: "agent:main:discord:channel:1",
        sessionId: "session-1",
        runId: "run-1",
        skillName: "debug-toolkit",
        skillSource: "workspace",
        activation: "read",
      }),
    ).toStrictEqual({
      kind: "skill_selection",
      schemaVersion: 1,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1",
      sessionId: "session-1",
      runId: "run-1",
      selectedSkill: "debug--toolkit",
      selectionSource: "observed_runtime",
      selectionConfidence: "observed",
      selectionRule: "tool_invocation",
      activation: "read",
      skillSource: "workspace",
      redaction: "metadata_only",
    });
  });

  it.each([
    // Distinct runtime names keep distinct audit identities.
    ["Daily Brief", "Daily-20-Brief"],
    ["Daily-Brief", "Daily--Brief"],
    ["_helper", "_helper"],
    ["helper", "helper"],
    ["../secret", "..-2f-secret"],
    ["___", "___"],
    ["-", "x---"],
    ["debug-toolkit", "debug--toolkit"],
    // Regression: late-hyphen names must keep their suffix.
    ["skill-a", "skill--a"],
    ["skill-b", "skill--b"],
  ])("preserves a distinguishable identity for %s", (skillName, expected) => {
    const marker = buildRuntimeSkillSelectionMarker({
      skillName,
      skillSource: "workspace",
      activation: "read",
    });
    expect(marker.selectedSkill).toBe(expected);
  });

  it("builds long identities from complete tokens only", () => {
    // 64 CJK chars encode to 768 chars, forcing the 128-char bound.
    const marker = buildRuntimeSkillSelectionMarker({
      skillName: "\u4e2d".repeat(64),
      skillSource: "workspace",
      activation: "read",
    });
    // Bounded to 128 chars, never cut inside a `-hh-` escape.
    expect(marker.selectedSkill.length).toBeLessThanOrEqual(128);
    expect(marker.selectedSkill).not.toMatch(/-[0-9a-f]{1,2}$/u);
    expect(marker.selectedSkill).toMatch(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/u);
  });

  it("returns unknown for empty skill names", () => {
    const marker = buildRuntimeSkillSelectionMarker({
      skillName: "   ",
      skillSource: "workspace",
      activation: "read",
    });
    expect(marker.selectedSkill).toBe("unknown");
  });
});
