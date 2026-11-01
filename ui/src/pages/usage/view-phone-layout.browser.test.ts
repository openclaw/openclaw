import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { formatIsoDate } from "./helpers.ts";
import { UsagePhoneActions } from "./view-actions.tsx";
import { usageState } from "./view-render.test-support.ts";
import { renderUsage } from "./view.tsx";

const today = formatIsoDate(new Date(), "local");
const todayRange = { startDate: today, endDate: today };

function mountPhoneUsage(filters: Parameters<typeof usageState>[0] = {}) {
  const state = usageState(filters);
  const agent = document.createElement("div");
  agent.id = "agent-scope";
  const view = mountSolid(() => renderUsage({ ...state.usage, agentScope: () => agent }));
  flush();
  return { ...state, root: view.container };
}

const trigger = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".usage-filter-sheet__trigger");

async function openSheet(root: ParentNode) {
  trigger(root)!.click();
  await waitForSolid(() => expect(root.querySelector(".usage-filter-sheet")).not.toBeNull());
  return root.querySelector<HTMLElement>(".usage-filter-sheet")!;
}

describe("Usage at phone width", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      createMediaQueryList(query, query === "(max-width: 640px)"),
    );
  });

  afterEach(() => {
    cleanupSolid();
    vi.restoreAllMocks();
  });

  it("keeps presets, agent, metric and the filter trigger on the page", () => {
    const { root } = mountPhoneUsage();
    const toolbar = root.querySelector(".usage-toolbar--phone")!;
    expect(toolbar.querySelector(".usage-presets")).not.toBeNull();
    const row = toolbar.querySelector(".usage-toolbar__row")!;
    expect(row.querySelector("#agent-scope")).not.toBeNull();
    expect(row.textContent).toContain("Tokens");
    expect(trigger(row)).not.toBeNull();

    for (const removed of [
      ".usage-pin-btn",
      ".usage-export-menu",
      ".usage-date-input",
      ".usage-query-input",
      ".usage-query-count",
      ".usage-filter-select",
    ]) {
      expect(root.querySelector(removed), removed).toBeNull();
    }
    expect(root.textContent).not.toContain("Tip:");
  });

  it("collects dates, time zone, identity, scope, query and facets in the sheet", async () => {
    const { root } = mountPhoneUsage();
    const sheet = await openSheet(root);
    expect(sheet.querySelector(".usage-filter-sheet__title")?.textContent).toBe("Filters");
    expect(sheet.querySelectorAll(".usage-date-input")).toHaveLength(2);
    expect(sheet.querySelectorAll(".usage-select")).toHaveLength(2);
    expect(sheet.textContent).toContain("Historical lineage");
    expect(sheet.querySelector(".usage-query-input")).not.toBeNull();
    expect(sheet.querySelectorAll(".usage-filter-select")).toHaveLength(4);
  });

  it.each([
    ["a preset range", {}, false],
    ["a custom range", { startDate: "2020-01-01", endDate: "2020-01-02" }, true],
    ["UTC", { timeZone: "utc" as const }, true],
    ["an identity", { creatorKey: "creator" }, true],
    ["the instance scope", { scope: "instance" as const }, true],
    ["a query", { query: "model:a", queryDraft: "model:a" }, true],
  ])("marks the trigger for %s", (_name, filters, active) => {
    const { root } = mountPhoneUsage({ ...todayRange, ...filters });
    expect(trigger(root)!.classList.contains("active")).toBe(active);
  });

  it("keeps applied query chips above the results", () => {
    const { root } = mountPhoneUsage({ query: "model:a", queryDraft: "model:a" });
    expect(root.querySelector(".usage-query-chip")?.textContent).toContain("model:a");
  });

  it("puts chart selections and query terms in one row before the count", () => {
    const { root } = mountPhoneUsage({
      selectedDays: ["2026-05-14"],
      query: "model:a",
      queryDraft: "model:a",
    });
    const row = root.querySelector(".usage-applied-filters")!;
    expect(row.querySelector(".filter-chip")?.textContent).toContain("2026-05-14");
    expect(row.querySelector(".usage-query-chip")?.textContent).toContain("model:a");
    expect(root.querySelectorAll(".usage-header .filter-chip")).toHaveLength(1);
  });

  it("does not pin the header at phone width", () => {
    const { root, setDisplay, usage } = mountPhoneUsage();
    setDisplay({ ...usage.display, headerPinned: true });
    flush();
    expect(root.querySelector(".usage-header")?.classList.contains("pinned")).toBe(false);
  });

  it("routes Refresh and every export through the three-dots menu", () => {
    const { usage } = usageState();
    const view = mountSolid(() => UsagePhoneActions(usage));
    flush();
    view.container.querySelector<HTMLButtonElement>(".oc-menu-trigger")!.click();
    flush();
    const values = [...view.container.querySelectorAll("[data-value]")].map((item) =>
      item.getAttribute("data-value"),
    );
    expect(values).toEqual(["refresh", "sessions-csv", "daily-csv", "json"]);
  });
});
