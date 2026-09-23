/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { buildProps, buildResult } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

describe("session goals", () => {
  it.each([
    { status: "active" as const, label: "Pursuing goal", kind: "ok" },
    { status: "paused" as const, label: "Goal paused", kind: "warn" },
  ])("renders $status session goals in the status cell", async ({ status, label, kind }) => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:goal",
            kind: "direct",
            updatedAt: 20,
            hasActiveRun: true,
            status: "running",
            goal: {
              schemaVersion: 1,
              id: "goal-1",
              objective: "Ship the web goal indicator",
              status,
              createdAt: 1,
              updatedAt: 2,
              tokenStart: 100,
              tokensUsed: 12_400,
              tokenBudget: 50_000,
              continuationTurns: 0,
            },
          }),
        ),
        searchQuery: "web goal",
      }),
      container,
    );
    await Promise.resolve();

    const statuses = container.querySelectorAll(".session-status-stack .settings-status");
    const goal = statuses[1];
    expect(goal?.textContent?.replace(/\s+/g, " ").trim()).toBe(`${label} (12k/50k)`);
    expect(goal?.classList.contains(`settings-status--${kind}`)).toBe(true);
    // The wrapper span exposes the objective to keyboard/screen-reader users.
    const wrapper = goal?.parentElement;
    expect(wrapper?.getAttribute("tabindex")).toBe("0");
    expect(wrapper?.getAttribute("aria-label")).toBe(
      `${label} (12k/50k): Ship the web goal indicator`,
    );
    const tooltip = wrapper?.parentElement as (HTMLElement & { content: string }) | null;
    expect(tooltip?.content).toBe(`${label} (12k/50k): Ship the web goal indicator`);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});
