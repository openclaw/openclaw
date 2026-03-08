import { describe, expect, it } from "vitest";
import type { ChangePlan } from "../contracts/change-plan.js";
import { renderChangePlanMarkdown } from "./render.js";

describe("renderChangePlanMarkdown", () => {
  it("renders repo sections and validations", () => {
    const plan: ChangePlan = {
      version: "sre.change-plan.v1",
      planId: "plan:1",
      incidentId: "incident:1",
      summary: "fix runtime",
      rootCauseSummary: "bad deploy",
      status: "draft",
      generatedAt: "2026-03-08T00:00:00.000Z",
      repos: ["openclaw-sre"],
      steps: [
        {
          repoId: "openclaw-sre",
          summary: "patch runtime",
          ownedGlobs: ["src/**"],
          validationCommands: ["pnpm build"],
          files: ["src/example.ts"],
          rollback: "revert commit",
        },
      ],
      provenance: [],
    };

    const markdown = renderChangePlanMarkdown(plan);
    expect(markdown).toContain("# Change Plan plan:1");
    expect(markdown).toContain("Root cause: bad deploy");
    expect(markdown).toContain("- openclaw-sre: patch runtime");
    expect(markdown).toContain("files: src/example.ts");
    expect(markdown).toContain("validate: pnpm build");
  });
});
