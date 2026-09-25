/* @vitest-environment jsdom */
import type { ProgressCard } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { renderSessionProgressCard } from "./session-progress-card.ts";

const containers: HTMLDivElement[] = [];
const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);
const RUN_STARTED_MS = NOW_MS - 3 * 60_000;
const RUN_ENDED_MS = NOW_MS - 30_000;
const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
});

it.each(["failed", "timeout", "killed", "done"] as const)(
  "keeps authoritative same-run activity ahead of a stale %s progress snapshot",
  (status) => {
    const container = document.createElement("div");
    containers.push(container);
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        status,
        RUN_STARTED_MS,
        RUN_ENDED_MS,
        true,
        false,
        { activeRunId: "run-1", snapshotRunId: "run-1" },
      ),
      container,
    );
    expect(
      container.querySelector(".session-progress-card__summary-count--collapsed")?.textContent,
    ).toBe("2/3");
    expect(container.querySelector("[data-outcome]")?.getAttribute("data-outcome")).toBe("running");
    expect(container.querySelector(".session-run-spinner")).not.toBeNull();
  },
);

it.each([
  { activeRunId: "run-2", snapshotRunId: "run-1" },
  { activeRunId: null, snapshotRunId: "run-1" },
  { activeRunId: "run-1", snapshotRunId: null },
])("retains a failure without matching active ownership %j", (lifecycle) => {
  const container = document.createElement("div");
  containers.push(container);
  render(
    renderSessionProgressCard(
      progressCard,
      "composer",
      undefined,
      "failed",
      RUN_STARTED_MS,
      RUN_ENDED_MS,
      true,
      false,
      lifecycle,
    ),
    container,
  );
  expect(
    container.querySelector(".session-progress-card__summary-count--collapsed")?.textContent,
  ).toBe("Failed");
});
