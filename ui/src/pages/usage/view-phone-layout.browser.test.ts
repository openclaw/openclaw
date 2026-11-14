import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { formatIsoDate } from "./helpers.ts";
import { usageState } from "./view-render.test-support.ts";
import { renderUsage } from "./view.tsx";

const today = formatIsoDate(new Date(), "local");
const todayRange = { startDate: today, endDate: today };

function mountPhoneUsage(filters: Parameters<typeof usageState>[0] = {}) {
  const state = usageState(filters);
  const view = mountSolid(() => renderUsage(state.usage));
  flush();
  return { ...state, root: view.container };
}

const trigger = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".usage-filter-sheet__trigger");

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

  it("keeps chart selections and query terms visible on the page", () => {
    const { root } = mountPhoneUsage({
      selectedDays: ["2026-05-14"],
      query: "model:a",
      queryDraft: "model:a",
    });
    expect(root.querySelector(".filter-chip")?.textContent).toContain("2026-05-14");
    expect(root.querySelector(".usage-query-chip")?.textContent).toContain("model:a");
  });
});
