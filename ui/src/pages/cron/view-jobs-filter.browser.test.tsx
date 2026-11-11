import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { JobsFilterPopover } from "./view-jobs-filter.tsx";
import type { CronProps } from "./view-types.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountFilter(phone: boolean) {
  const matchMedia = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) =>
    query.startsWith("(max-width: 640px)") ? createMediaQueryList(query, phone) : matchMedia(query),
  );
  const onJobsFiltersChange = vi.fn();
  const view = render(() => (
    <JobsFilterPopover
      {...({
        jobsScheduleKindFilter: "all",
        jobsLastStatusFilter: "all",
        jobsTriggerFilter: "all",
        jobsSortBy: "nextRunAtMs",
        jobsSortDir: "asc",
        onJobsFiltersChange,
        onJobsFiltersReset: () => {},
      } as unknown as CronProps)}
      active={false}
    />
  ));
  flush();
  return { view, onJobsFiltersChange };
}

describe("Automations filter", () => {
  it("opens as a sheet on phones with every filter", async () => {
    const { view, onJobsFiltersChange } = mountFilter(true);
    await userEvent.click(view.getByRole("button", { name: "Filters" }));
    const sheet = document.querySelector<HTMLElement>("#cron-jobs-filter-popover")!;
    await phase(sheet, "open");
    expect(sheet.classList.contains("oc-sheet")).toBe(true);
    expect(sheet.querySelectorAll("select")).toHaveLength(5);
    const lastRun = sheet.querySelector<HTMLSelectElement>(
      '[data-test-id="cron-jobs-last-status-filter"]',
    )!;
    await userEvent.selectOptions(lastRun, "error");
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "error" });
    expect(sheet.querySelector('[data-test-id="cron-jobs-filters-reset"]')).not.toBeNull();
  });

  it("stays an anchored popover wider than a phone", async () => {
    const { view } = mountFilter(false);
    await userEvent.click(view.getByRole("button", { name: "Filters" }));
    const popover = document.querySelector<HTMLElement>("#cron-jobs-filter-popover")!;
    await phase(popover, "open");
    expect(popover.classList.contains("oc-sheet")).toBe(false);
    expect(popover.getBoundingClientRect().width).toBeLessThan(
      document.documentElement.clientWidth,
    );
  });
});
