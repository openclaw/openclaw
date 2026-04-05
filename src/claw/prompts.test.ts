import { describe, expect, it } from "vitest";
import {
  buildClawPlanningExtraSystemPrompt,
  buildClawPlanningPrompt,
  buildClawVerifierExtraSystemPrompt,
} from "./prompts.js";

describe("claw prompts", () => {
  it("describes planning as pre-approval preparation for unattended continuation", () => {
    expect(buildClawPlanningExtraSystemPrompt()).toContain(
      "before unattended continuation is approved",
    );
    expect(buildClawPlanningExtraSystemPrompt()).toContain(
      "Bounded pre-start inspection or mutation is allowed",
    );
    expect(
      buildClawPlanningPrompt({
        missionId: "mission-1",
        title: "Test mission",
        goal: "Implement the requested Claw behavior.",
        workspaceDir: "/tmp/workspace",
      }),
    ).toContain("Bounded pre-start work may already inspect or change state");
  });

  it("describes verifier work as fresh-context judgment without read-only assumptions", () => {
    expect(buildClawVerifierExtraSystemPrompt()).toContain("fresh-context verification pass");
    expect(buildClawVerifierExtraSystemPrompt()).toContain(
      "do not assume verification is read-only",
    );
  });
});
