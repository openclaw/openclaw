/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import type { SessionRowBadgesParams } from "./session-row-badge-presentation.ts";
import { SessionRowBadges } from "./solid/session-presentation.tsx";
import "./tooltip.ts";

let container: HTMLDivElement;
let view: ReturnType<typeof mountSolid> | undefined;

function renderBadges(params: SessionRowBadgesParams) {
  view?.unmount();
  view = mountSolid(() => createComponent(SessionRowBadges, params), { container });
}

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  container.remove();
});

function expectLabel(indicator: Element | null | undefined, text: string) {
  expect(indicator?.getAttribute("aria-label")).toBe(text);
  expect(indicator?.hasAttribute("title")).toBe(false);
  expect(
    (indicator?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
      ?.content,
  ).toBe(text);
}

function badge(kind: string) {
  return container.querySelector<HTMLElement>(`.session-row-badge--${kind}`);
}

describe("session row placement badges", () => {
  it("names the service, profile, and machine without losing conflict or disk attention", () => {
    renderBadges({
      placementState: "active",
      placementProviderId: "machine0",
      placementProfileId: "team",
      placementMachine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
      workspaceConflictCount: 2,
      diskSpaceStatus: "warning",
    });
    const label =
      "machine0 · team · Linux · medium · 4 vCPU · 16 GB · active · 2 workspace conflicts · Cloud session disk space is low";
    expectLabel(badge("cloud"), label);
  });

  it("renders the incognito indicator", () => {
    renderBadges({ incognito: true });

    expectLabel(badge("incognito"), "Incognito session");
  });

  it("renders outbox attention and stays quiet when empty", () => {
    renderBadges({ hasApproval: true, outboxAttentionCount: 3 });

    const indicator = badge("attention");
    expectLabel(indicator, "3 messages need attention");
    expect(indicator?.textContent).toContain("3");
    const attentionIcon = indicator?.querySelector("svg");
    const approvalIcon = badge("approval svg");
    expect(attentionIcon?.isEqualNode(approvalIcon ?? null)).toBe(true);

    renderBadges({ outboxAttentionCount: 1 });
    expect(badge("attention")?.getAttribute("aria-label")).toBe("1 message needs attention");

    renderBadges({ outboxAttentionCount: 0 });
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it.each(["local", "reclaimed"] as const)(
    "keeps %s placement visually quiet",
    (placementState) => {
      renderBadges({ placementState });

      expect(container.querySelector(".session-row-badges")).toBeNull();
    },
  );

  it("renders a cloud-worker placement as a globe", () => {
    renderBadges({ placementState: "active" });
    const indicator = badge("cloud");
    expect(indicator?.dataset.placementState).toBe("active");
    expectLabel(indicator, "Placement: active");
    expect(indicator?.querySelector("circle")).not.toBeNull();
    expect(indicator?.querySelector("rect")).toBeNull();
  });

  it.each([
    { state: "open", numbers: [111532], label: "#111532 · Open" },
    { state: "draft", numbers: [107302], label: "#107302 · Draft" },
    { state: "merged", numbers: [111751, 111772], label: "#111751, #111772 · Merged" },
  ] as const)(
    "renders catalog pull request metadata for $state threads",
    ({ state, numbers, label }) => {
      renderBadges({ pullRequest: { numbers: [...numbers], state } });
      const indicator = badge("pull-request");
      expectLabel(indicator, label);
      expect(indicator?.getAttribute("data-pull-request-state")).toBe(state);
      expect(indicator?.querySelector("svg")).not.toBeNull();
    },
  );

  it("renders a warning-colored approval-needed indicator", () => {
    renderBadges({ hasApproval: true });

    const indicator = badge("approval");
    expectLabel(indicator, "Approval needed");
    expect(indicator?.querySelector("svg")).not.toBeNull();
  });

  it("keeps child placement badges hidden while showing PR and approval", () => {
    renderBadges({
      isChild: true,
      pullRequest: { numbers: [111532], state: "open" },
      hasApproval: true,
      placementState: "active",
    });

    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(2);
    expect(badge("pull-request")).not.toBeNull();
    expect(badge("approval")).not.toBeNull();
    expect(badge("cloud")).toBeNull();
  });

  it.each([
    ["active", false, 3, "Placement: active · 3 workspace conflicts"],
    ["active", false, 1, "Placement: active · 1 workspace conflict"],
    ["reclaimed", false, 2, "Placement: reclaimed · 2 workspace conflicts"],
    ["reclaimed", true, 2, "Placement: reclaimed · 2 workspace conflicts"],
    [undefined, false, 2, "Cloud worker children: 2 workspace conflicts"],
  ] as const)(
    "keeps conflict attention for %s placement (child: %s, count: %s)",
    (placementState, isChild, count, label) => {
      renderBadges({ placementState, isChild, workspaceConflictCount: count });
      const indicator = badge("cloud");
      expect(indicator?.dataset.placementState).toBe(placementState);
      expect(indicator?.dataset.workspaceConflicts).toBe(String(count));
      expectLabel(indicator, label);
      expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
    },
  );

  it.each([
    { status: "warning" as const, label: "Cloud session disk space is low" },
    { status: "critical" as const, label: "Cloud session disk space is critically low" },
  ])("uses the cloud badge's $status tone for background pressure", ({ status, label }) => {
    renderBadges({ placementState: "active", diskSpaceStatus: status });

    const indicator = badge("cloud");
    expect(indicator?.dataset.diskSpaceStatus).toBe(status);
    expectLabel(indicator, `Placement: active · ${label}`);
    expect(container.querySelectorAll(".session-row-badge--cloud")).toHaveLength(1);
  });
});
