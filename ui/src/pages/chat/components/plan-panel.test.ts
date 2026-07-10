/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPlanState } from "../../../api/types.ts";
import { extractPlanChecklist, type PlanChecklist } from "../../../lib/plan-checklist.ts";
import {
  getPlanChecklist,
  resetPlanChecklistStoreForTest,
  setPlanChecklist,
} from "../plan-stream-store.ts";
import { renderPlanPanel } from "./plan-panel.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const planningState: SessionPlanState = {
  schemaVersion: 1,
  status: "planning",
  enteredAt: 1,
  updatedAt: 2,
};

const checklist: PlanChecklist = {
  explanation: "Refined the approach",
  steps: [
    { step: "Research the seam", status: "completed" },
    { step: "Write the gate", status: "in_progress" },
    { step: "Add tests", status: "pending" },
  ],
};

describe("renderPlanPanel", () => {
  it("renders nothing when not in plan mode", () => {
    render(renderPlanPanel({ plan: null }), container);
    expect(container.querySelector("[data-plan-panel]")).toBeNull();
  });

  it("renders the state chip and checklist while planning", () => {
    render(renderPlanPanel({ plan: planningState, checklist }), container);
    const panel = container.querySelector("[data-plan-panel]");
    expect(panel?.getAttribute("data-plan-state")).toBe("planning");
    expect(container.querySelector("[data-plan-chip]")?.textContent?.trim()).toBe("Planning");
    expect(container.querySelectorAll(".plan-panel__step")).toHaveLength(3);
    expect(container.textContent).toContain("Write the gate");
    expect(container.textContent).toContain("1/3 done");
    // No approval controls while merely planning.
    expect(container.querySelector("[data-plan-approve]")).toBeNull();
  });

  it("shows the awaiting-approval chip and summary; approval controls live in the inline card", () => {
    const pending: SessionPlanState = {
      ...planningState,
      status: "pending_approval",
      lastSummary: "Ship the feature",
    };
    render(renderPlanPanel({ plan: pending, checklist }), container);
    expect(container.querySelector("[data-plan-chip]")?.textContent?.trim()).toBe(
      "Awaiting approval",
    );
    expect(container.textContent).toContain("Ship the feature");
    // Approve/revise moved to the dedicated <openclaw-inline-plan-approval> card.
    expect(container.querySelector("[data-plan-approve]")).toBeNull();
    expect(container.querySelector("[data-plan-reject]")).toBeNull();
  });

  it("shows the empty state when there are no steps yet", () => {
    render(renderPlanPanel({ plan: planningState, checklist: { steps: [] } }), container);
    expect(container.querySelector(".plan-panel__empty")).not.toBeNull();
  });
});

describe("plan panel live stream:plan sequence", () => {
  const sessionKey = "agent:main:web:main";

  beforeEach(() => resetPlanChecklistStoreForTest());
  afterEach(() => resetPlanChecklistStoreForTest());

  // Simulates a stream:plan sequence: each update_plan tool result is captured into the store
  // (as handleAgentEvent does) and the panel re-renders from it.
  function feedAndRender(steps: { step: string; status: string }[]): void {
    const parsed = extractPlanChecklist({ details: { status: "updated", plan: steps } });
    expect(parsed).not.toBeNull();
    setPlanChecklist(sessionKey, parsed as PlanChecklist);
    render(
      renderPlanPanel({ plan: planningState, checklist: getPlanChecklist(sessionKey) }),
      container,
    );
  }

  function stepClass(index: number): string {
    return container.querySelectorAll(".plan-panel__step")[index]?.className ?? "";
  }

  it("re-renders step status transitions as successive plan updates stream in", () => {
    feedAndRender([
      { step: "Research the seam", status: "in_progress" },
      { step: "Write the gate", status: "pending" },
    ]);
    expect(container.querySelectorAll(".plan-panel__step")).toHaveLength(2);
    expect(stepClass(0)).toContain("plan-panel__step--in_progress");
    expect(stepClass(1)).toContain("plan-panel__step--pending");
    expect(container.textContent).toContain("0/2 done");

    // Next delta: step 1 completes, step 2 starts, a third step appears.
    feedAndRender([
      { step: "Research the seam", status: "completed" },
      { step: "Write the gate", status: "in_progress" },
      { step: "Add tests", status: "pending" },
    ]);
    expect(container.querySelectorAll(".plan-panel__step")).toHaveLength(3);
    expect(stepClass(0)).toContain("plan-panel__step--completed");
    expect(stepClass(1)).toContain("plan-panel__step--in_progress");
    expect(container.textContent).toContain("1/3 done");
    expect(container.textContent).toContain("Add tests");
  });
});
