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
  ])("preserves a distinguishable identity for %s", (skillName, expected) => {
    const marker = buildRuntimeSkillSelectionMarker({
      skillName,
      skillSource: "workspace",
      activation: "read",
    });
    expect(marker.selectedSkill).toBe(expected);
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
