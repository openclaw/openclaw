/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { beforeEach, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import type { SessionRowBadgesParams } from "./session-row-badge-presentation.ts";
import { SessionRowBadges } from "./solid/session-presentation.tsx";
import "./tooltip.ts";

const renderBadges = (params: SessionRowBadgesParams) =>
  mountSolid(() => createComponent(SessionRowBadges, params)).container;
const badge = (container: HTMLElement, kind: string) =>
  container.querySelector<HTMLElement>(`.session-row-badge--${kind}`);

beforeEach(() => i18n.setLocale("en"));

function renderBadge(params: SessionRowBadgesParams, kind: string, text: string) {
  const indicator = badge(renderBadges(params), kind);
  expect(indicator?.getAttribute("aria-label")).toBe(text);
  expect(indicator?.getAttribute("title")).toBe(text);
  expect(indicator?.querySelector(".session-css-icon")).not.toBeNull();
  return indicator;
}

it.each<[string, SessionRowBadgesParams, string]>([
  ["incognito", { incognito: true }, "Incognito session"],
  ["approval", { hasApproval: true }, "Approval needed"],
])("renders the %s indicator: %s", (kind, params, label) => {
  renderBadge(params, kind, label);
});

it("renders outbox attention and stays quiet when empty", () => {
  const indicator = renderBadge(
    { outboxAttentionCount: 3 },
    "attention",
    "3 messages need attention",
  );
  expect(indicator?.textContent).toContain("3");
  const approval = badge(renderBadges({ hasApproval: true }), "approval");
  expect(
    indicator
      ?.querySelector(".session-css-icon")
      ?.isEqualNode(approval?.querySelector(".session-css-icon") ?? null),
  ).toBe(true);

  expect(
    badge(renderBadges({ outboxAttentionCount: 1 }), "attention")?.getAttribute("aria-label"),
  ).toBe("1 message needs attention");

  expect(renderBadges({ outboxAttentionCount: 0 }).querySelector(".session-row-badges")).toBeNull();
});

it("keeps child placement badges hidden while showing approval", () => {
  const container = renderBadges({
    isChild: true,
    hasApproval: true,
    placementState: "active",
  });

  expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
  expect(badge(container, "approval")).not.toBeNull();
  expect(badge(container, "cloud")).toBeNull();
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
    const indicator = renderBadge(
      { placementState, isChild, workspaceConflictCount: count },
      "cloud",
      label,
    );
    expect(indicator?.dataset.placementState).toBe(placementState);
    expect(indicator?.dataset.workspaceConflicts).toBe(String(count));
    expect(
      indicator?.closest(".session-row-badges")?.querySelectorAll(".session-row-badge"),
    ).toHaveLength(1);
  },
);

it("keeps the two most urgent badges in reading order and caps counts", () => {
  const container = renderBadges({
    incognito: true,
    outboxAttentionCount: 140,
    hasComposerDraft: true,
  });
  expect(
    [...container.querySelectorAll(".session-row-badge")].map((element) => element.className),
  ).toEqual([
    "session-row-badge session-row-badge--attention",
    "session-row-badge session-row-badge--draft",
  ]);
  expect(badge(container, "attention")?.textContent).toBe("99+");
  expect(badge(container, "attention")?.getAttribute("aria-label")).toBe(
    "140 messages need attention",
  );
});

it("shows cloud placement in every worker state", () => {
  expect(badge(renderBadges({ placementState: "active" }), "cloud")).not.toBeNull();
  expect(badge(renderBadges({ placementState: "provisioning" }), "cloud")).not.toBeNull();
  expect(badge(renderBadges({ placementState: "failed" }), "cloud")).not.toBeNull();
  expect(badge(renderBadges({ placementState: "local" }), "cloud")).toBeNull();
});
