/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderSessionRowBadges, type SessionPlacementState } from "./session-row-badges.ts";
import "./tooltip.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

function renderBadges(
  placementState?: SessionPlacementState,
  workspaceConflictCount?: number,
  diskSpaceStatus?: "ok" | "warning" | "critical",
) {
  render(
    renderSessionRowBadges({
      placementState,
      workspaceConflictCount,
      diskSpaceStatus,
    }),
    container,
  );
}

function expectTooltipText(badge: Element | null | undefined, text: string) {
  expect(badge?.hasAttribute("title")).toBe(false);
  expect(
    (badge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
  ).toBe(text);
}

describe("session row placement badges", () => {
  it("names the service, profile, and machine without losing conflict or disk attention", () => {
    render(
      renderSessionRowBadges({
        placementState: "active",
        placementProviderId: "machine0",
        placementProfileId: "team",
        placementMachine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
        workspaceConflictCount: 2,
        diskSpaceStatus: "warning",
      }),
      container,
    );
    const label =
      "machine0 · team · Linux · medium · 4 vCPU · 16 GB · active · 2 workspace conflicts · Cloud session disk space is low";
    const badge = container.querySelector(".session-row-badge--cloud");
    expect(badge?.getAttribute("aria-label")).toBe(label);
    expectTooltipText(badge, label);
  });

  it("renders the incognito indicator", () => {
    render(
      renderSessionRowBadges({
        incognito: true,
      }),
      container,
    );

    const badge = container.querySelector(".session-row-badge--incognito");
    expect(badge?.getAttribute("aria-label")).toBe("Incognito session");
    expectTooltipText(badge, "Incognito session");
  });

  it("renders outbox attention and stays quiet when empty", () => {
    render(
      renderSessionRowBadges({
        hasApproval: true,
        outboxAttentionCount: 3,
      }),
      container,
    );

    const badge = container.querySelector<HTMLElement>(".session-row-badge--attention");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages need attention");
    expectTooltipText(badge, "3 messages need attention");
    expect(badge?.textContent).toContain("3");
    const attentionIcon = badge?.querySelector("svg");
    const approvalIcon = container.querySelector(".session-row-badge--approval svg");
    expect(attentionIcon?.isEqualNode(approvalIcon ?? null)).toBe(true);

    render(renderSessionRowBadges({ outboxAttentionCount: 1 }), container);
    expect(
      container.querySelector(".session-row-badge--attention")?.getAttribute("aria-label"),
    ).toBe("1 message needs attention");

    render(renderSessionRowBadges({ outboxAttentionCount: 0 }), container);
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it.each([{ state: "merged" as const, label: "#111751, #111772 · Merged" }])(
    "renders catalog pull request metadata for $state threads",
    ({ state, label }) => {
      render(
        renderSessionRowBadges({
          pullRequest: {
            numbers: [111751, 111772],
            state,
          },
        }),
        container,
      );

      const badge = container.querySelector(".session-row-badge--pull-request");
      expect(badge?.getAttribute("aria-label")).toBe(label);
      expectTooltipText(badge, label);
      expect(badge?.getAttribute("data-pull-request-state")).toBe(state);
    },
  );

  it("keeps conflict attention visible for child sessions", () => {
    render(
      renderSessionRowBadges({
        isChild: true,
        placementState: "reclaimed",
        workspaceConflictCount: 2,
      }),
      container,
    );

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBe("reclaimed");
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
  });

  it("uses the existing cloud badge to call out workspace conflicts", () => {
    renderBadges("active", 3);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.workspaceConflicts).toBe("3");
    expectTooltipText(badge, "Placement: active · 3 workspace conflicts");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);

    renderBadges("active", 1);
    expectTooltipText(
      container.querySelector(".session-row-badge--cloud"),
      "Placement: active · 1 workspace conflict",
    );
  });

  it.each([{ status: "critical" as const, label: "Cloud session disk space is critically low" }])(
    "uses the cloud badge's $status tone for background pressure",
    ({ status, label }) => {
      renderBadges("active", undefined, status);

      const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
      expect(badge?.dataset.diskSpaceStatus).toBe(status);
      expectTooltipText(badge, `Placement: active · ${label}`);
      expect(container.querySelectorAll(".session-row-badge--cloud")).toHaveLength(1);
    },
  );

  it("renders descendant conflict attention without claiming a parent placement state", () => {
    renderBadges(undefined, 2);

    const badge = container.querySelector<HTMLElement>(".session-row-badge--cloud");
    expect(badge?.dataset.placementState).toBeUndefined();
    expect(badge?.dataset.workspaceConflicts).toBe("2");
    expectTooltipText(badge, "Cloud worker children: 2 workspace conflicts");
  });
});
