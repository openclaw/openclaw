/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlanState } from "../../../api/types.ts";
import type { PlanChecklist } from "../../../lib/session-plan.ts";
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

  it("shows approve/keep-planning controls only when awaiting approval", () => {
    const pending: SessionPlanState = {
      ...planningState,
      status: "pending_approval",
      lastSummary: "Ship the feature",
    };
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      renderPlanPanel({ plan: pending, checklist, actions: { onApprove, onReject } }),
      container,
    );
    expect(container.querySelector("[data-plan-chip]")?.textContent?.trim()).toBe(
      "Awaiting approval",
    );
    const approve = container.querySelector<HTMLButtonElement>("[data-plan-approve]");
    const reject = container.querySelector<HTMLButtonElement>("[data-plan-reject]");
    expect(approve).not.toBeNull();
    expect(reject).not.toBeNull();
    approve?.click();
    reject?.click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Ship the feature");
  });

  it("shows the empty state when there are no steps yet", () => {
    render(renderPlanPanel({ plan: planningState, checklist: { steps: [] } }), container);
    expect(container.querySelector(".plan-panel__empty")).not.toBeNull();
  });
});
