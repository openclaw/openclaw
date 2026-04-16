import { render } from "lit";
import { describe, expect, it } from "vitest";
import { formatPlanAsMarkdown, type PlanCardData, renderPlanCard } from "./plan-cards.js";

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

describe("renderPlanCard (jsdom render — Copilot r3095798656)", () => {
  function renderToHost(plan: PlanCardData): HTMLElement {
    const host = document.createElement("div");
    render(renderPlanCard(plan), host);
    return host;
  }

  it("renders <details>/<summary> structure with title and meta", () => {
    const host = renderToHost({
      title: "Deploy Pipeline",
      steps: [
        { text: "A", status: "completed" },
        { text: "B", status: "pending" },
      ],
    });
    const details = host.querySelector("details.chat-plan-card");
    expect(details).not.toBeNull();
    const summary = details?.querySelector("summary");
    expect(summary?.textContent).toContain("Deploy Pipeline");
    // Meta line shows N/M done.
    expect(summary?.textContent).toContain("1/2 done");
  });

  it("renders explanation block when present", () => {
    const host = renderToHost({
      title: "T",
      explanation: "Why we are doing this",
      steps: [{ text: "S", status: "pending" }],
    });
    const explanation = host.querySelector(".chat-plan-card__explanation");
    expect(explanation?.textContent).toBe("Why we are doing this");
  });

  it("omits explanation block when absent", () => {
    const host = renderToHost({
      title: "T",
      steps: [{ text: "S", status: "pending" }],
    });
    expect(host.querySelector(".chat-plan-card__explanation")).toBeNull();
  });

  it("renders one li per step with status-specific class", () => {
    const host = renderToHost({
      title: "T",
      steps: [
        { text: "A", status: "completed" },
        { text: "B", status: "in_progress" },
        { text: "C", status: "pending" },
        { text: "D", status: "cancelled" },
      ],
    });
    const steps = host.querySelectorAll("li.chat-plan-card__step");
    expect(steps).toHaveLength(4);
    expect(steps[0].classList.contains("chat-plan-card__step--completed")).toBe(true);
    expect(steps[1].classList.contains("chat-plan-card__step--in-progress")).toBe(true);
    expect(steps[2].classList.contains("chat-plan-card__step--pending")).toBe(true);
    expect(steps[3].classList.contains("chat-plan-card__step--cancelled")).toBe(true);
  });

  it("uses activeForm for in_progress steps when present", () => {
    const host = renderToHost({
      title: "T",
      steps: [{ text: "Build", status: "in_progress", activeForm: "Building artifacts" }],
    });
    expect(host.textContent).toContain("Building artifacts");
    expect(host.textContent).not.toContain("Build artifacts"); // step text shadowed
  });

  it("shows N steps meta when nothing is completed", () => {
    const host = renderToHost({
      title: "T",
      steps: [
        { text: "A", status: "pending" },
        { text: "B", status: "pending" },
      ],
    });
    expect(host.querySelector("summary")?.textContent).toContain("2 steps");
  });
});
