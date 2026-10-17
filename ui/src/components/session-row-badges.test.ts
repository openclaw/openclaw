/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import type {
  SessionPlacementState,
  SessionRowBadgesParams,
} from "./session-row-badge-presentation.ts";
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

function renderPlacementBadges(
  placementState?: SessionPlacementState,
  workspaceConflictCount?: number,
  diskSpaceStatus?: "ok" | "warning" | "critical",
) {
  renderBadges({ placementState, workspaceConflictCount, diskSpaceStatus });
}

function expectLabel(indicator: Element | null | undefined, text: string) {
  expect(indicator?.getAttribute("aria-label")).toBe(text);
  expect(indicator?.hasAttribute("title")).toBe(false);
  expect(
    (indicator?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
      ?.content,
  ).toBe(text);
}

function badge<T extends Element = HTMLElement>(kind: string) {
  return container.querySelector<T>(`.session-row-badge--${kind}`);
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
    const indicator = badge("cloud");
    expectLabel(indicator, label);
  });

  it("renders the incognito indicator", () => {
    renderBadges({ incognito: true });

    const indicator = badge("incognito");
    expectLabel(indicator, "Incognito session");
  });

  it("renders outbox attention and stays quiet when empty", () => {
    renderBadges({ hasApproval: true, outboxAttentionCount: 3 });

    const indicator = badge<HTMLElement>("attention");
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

  it.each(["local", "reclaimed"] satisfies SessionPlacementState[])(
    "keeps %s placement visually quiet",
    (placementState) => {
      renderPlacementBadges(placementState);

      expect(container.querySelector(".session-row-badges")).toBeNull();
    },
  );

  it("renders a cloud-worker placement as a globe", () => {
    const placementState = "active";
    renderPlacementBadges(placementState);

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.placementState).toBe(placementState);
    expectLabel(indicator, `Placement: ${placementState}`);
    expect(indicator?.querySelector("circle")).not.toBeNull();
    expect(indicator?.querySelector("rect")).toBeNull();
  });

  it("renders a green open-pull-request indicator", () => {
    renderBadges({ pullRequest: { numbers: [111532], state: "open" } });

    const indicator = badge("pull-request");
    expectLabel(indicator, "#111532 · Open");
    expect(indicator?.getAttribute("data-pull-request-state")).toBe("open");
    expect(indicator?.querySelector("svg")).not.toBeNull();
  });

  it.each([
    { state: "draft" as const, label: "#107302 · Draft" },
    { state: "merged" as const, label: "#111751, #111772 · Merged" },
  ])("renders catalog pull request metadata for $state threads", ({ state, label }) => {
    renderBadges({
      pullRequest: { numbers: state === "draft" ? [107302] : [111751, 111772], state },
    });

    const indicator = badge("pull-request");
    expectLabel(indicator, label);
    expect(indicator?.getAttribute("data-pull-request-state")).toBe(state);
  });

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

  it("keeps conflict attention visible for child sessions", () => {
    renderBadges({ isChild: true, placementState: "reclaimed", workspaceConflictCount: 2 });

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.placementState).toBe("reclaimed");
    expect(indicator?.dataset.workspaceConflicts).toBe("2");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
  });

  it("uses the existing cloud badge to call out workspace conflicts", () => {
    renderPlacementBadges("active", 3);

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.workspaceConflicts).toBe("3");
    expectLabel(indicator, "Placement: active · 3 workspace conflicts");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);

    renderPlacementBadges("active", 1);
    expectLabel(badge("cloud"), "Placement: active · 1 workspace conflict");
  });

  it.each([
    { status: "warning" as const, label: "Cloud session disk space is low" },
    { status: "critical" as const, label: "Cloud session disk space is critically low" },
  ])("uses the cloud badge's $status tone for background pressure", ({ status, label }) => {
    renderPlacementBadges("active", undefined, status);

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.diskSpaceStatus).toBe(status);
    expectLabel(indicator, `Placement: active · ${label}`);
    expect(container.querySelectorAll(".session-row-badge--cloud")).toHaveLength(1);
  });

  it("keeps retained workspace conflicts visible after reclaim", () => {
    renderPlacementBadges("reclaimed", 2);

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.placementState).toBe("reclaimed");
    expect(indicator?.dataset.workspaceConflicts).toBe("2");
    expectLabel(indicator, "Placement: reclaimed · 2 workspace conflicts");
  });

  it("renders descendant conflict attention without claiming a parent placement state", () => {
    renderPlacementBadges(undefined, 2);

    const indicator = badge<HTMLElement>("cloud");
    expect(indicator?.dataset.placementState).toBeUndefined();
    expect(indicator?.dataset.workspaceConflicts).toBe("2");
    expectLabel(indicator, "Cloud worker children: 2 workspace conflicts");
  });
});
