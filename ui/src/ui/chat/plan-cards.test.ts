import { describe, expect, it } from "vitest";
import { formatPlanAsMarkdown, type PlanCardData } from "./plan-cards.js";

describe("formatPlanAsMarkdown", () => {
  const basePlan: PlanCardData = {
    title: "Deploy Pipeline",
    explanation: "Standard deployment checklist",
    steps: [
      { text: "Run tests", status: "completed" },
      { text: "Build artifacts", status: "in_progress", activeForm: "Building artifacts" },
      { text: "Deploy to staging", status: "pending" },
      { text: "Fix broken migration", status: "cancelled" },
    ],
  };

  it("renders title as h2", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("## Deploy Pipeline");
  });

  it("renders explanation in italics", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("_Standard deployment checklist_");
  });

  it("renders completed steps with [x]", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("- [x] Run tests");
  });

  it("renders pending steps with [ ]", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("- [ ] Deploy to staging");
  });

  it("renders cancelled steps with strikethrough and label", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("- [ ] ~~Fix broken migration~~ (cancelled)");
  });

  it("renders in_progress steps with bold and label", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("- [ ] **Building artifacts** (in progress)");
  });

  it("uses activeForm for in_progress steps when present", () => {
    const md = formatPlanAsMarkdown(basePlan);
    expect(md).toContain("Building artifacts");
    expect(md).not.toContain("Build artifacts");
  });

  it("uses step text when activeForm is absent", () => {
    const plan: PlanCardData = {
      title: "Test",
      steps: [{ text: "Run lint", status: "in_progress" }],
    };
    const md = formatPlanAsMarkdown(plan);
    expect(md).toContain("**Run lint**");
  });

  it("omits explanation when not provided", () => {
    const plan: PlanCardData = {
      title: "Quick Plan",
      steps: [{ text: "Step 1", status: "pending" }],
    };
    const md = formatPlanAsMarkdown(plan);
    expect(md).not.toContain("_");
    expect(md).toContain("## Quick Plan");
    expect(md).toContain("- [ ] Step 1");
  });

  it("handles empty steps array", () => {
    const plan: PlanCardData = { title: "Empty", steps: [] };
    const md = formatPlanAsMarkdown(plan);
    expect(md).toContain("## Empty");
    expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(0);
  });
});
