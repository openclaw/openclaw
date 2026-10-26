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
  expect(indicator?.closest<HTMLElement & { content?: string }>("openclaw-tooltip")?.content).toBe(
    text,
  );
}

function badge(kind: string) {
  return container.querySelector<HTMLElement>(`.session-row-badge--${kind}`);
}

describe("session row placement badges", () => {
  it.each([
    ["incognito", { incognito: true }, "Incognito session"],
    ["approval", { hasApproval: true }, "Approval needed"],
  ] as const)("renders the %s indicator", (kind, params, label) => {
    renderBadges(params);
    expectLabel(badge(kind), label);
    if (kind === "approval") {
      expect(badge(kind)?.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders outbox attention and stays quiet when empty", () => {
    renderBadges({ hasApproval: true, outboxAttentionCount: 3 });

    const indicator = badge("attention");
    expectLabel(indicator, "3 messages need attention");
    expect(indicator?.textContent).toContain("3");
    expect(indicator?.querySelector("svg")?.isEqualNode(badge("approval svg") ?? null)).toBe(true);

    renderBadges({ outboxAttentionCount: 1 });
    expect(badge("attention")?.getAttribute("aria-label")).toBe("1 message needs attention");

    renderBadges({ outboxAttentionCount: 0 });
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it.each([
    { state: "open", numbers: [111532], label: "#111532 · Open" },
    { state: "draft", numbers: [107302], label: "#107302 · Draft" },
    {
      state: "merged",
      numbers: [111751, 111772],
      label: "2 pull requests · #111751, #111772 · Merged",
    },
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
});
