import { createComponent } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { extractQueryTerms } from "../../../src/shared/usage-query.js";
import { registerUsageEnglish } from "../i18n/locales/en-usage.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { RunsSection } from "../pages/cron/view-runs.tsx";
import { UsageQueryFilter } from "../pages/usage/view-query-filter.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { Menu } from "./solid/menu.tsx";
import "../styles.css";
import "../styles/cron.css";
import "../styles/usage.css";

registerEnglishCatalog(registerUsageEnglish);
const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(cleanupSolid);

function partBounds(item: HTMLElement, part: "check" | "label" | "icon"): DOMRect {
  const element = item.querySelector<HTMLElement>(`.oc-menu-item__${part}`);
  expect(element, `${part} should exist`).not.toBeNull();
  return element!.getBoundingClientRect();
}

async function openMenu(container: HTMLElement) {
  container.dir = "ltr";
  const surface = container.querySelector<HTMLElement>('[role="menu"]')!;
  surface.style.width = "240px";
  container.querySelector<HTMLButtonElement>(".oc-menu-trigger")!.click();
  await waitForSolid(() => expect(surface.dataset.phase).toBe("open"));
  expect(surface.matches(":popover-open")).toBe(true);
  return surface;
}

describe.skipIf(!hasBrowserLayout)("menu selection check alignment", () => {
  it("keeps command-menu icons aligned and selection checks in the trailing rail", async () => {
    const view = mountSolid(() =>
      createComponent(Menu, {
        id: "check-alignment",
        label: "Actions",
        items: [
          { id: "selected", label: "Selected", type: "checkbox", checked: true, icon: "#" },
          { id: "unselected", label: "Unselected", type: "checkbox", checked: false, icon: "#" },
          { id: "command", label: "Command", icon: "#" },
        ],
      }),
    );
    flush();
    await openMenu(view.container);
    const selected = view.getByRole("menuitemcheckbox", { name: "Selected" });
    const unselected = view.getByRole("menuitemcheckbox", { name: "Unselected" });
    const command = view.getByRole("menuitem", { name: "Command" });
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(unselected.getAttribute("aria-checked")).toBe("false");
    expect(command.hasAttribute("aria-checked")).toBe(false);

    for (const item of [selected, unselected]) {
      const check = partBounds(item, "check");
      const label = partBounds(item, "label");
      expect(check.width).toBeGreaterThan(0);
      expect(label.width).toBeGreaterThan(0);
      expect(check.left).toBeGreaterThanOrEqual(label.right);
      expect(
        Math.abs(check.top + check.height / 2 - label.top - label.height / 2),
      ).toBeLessThanOrEqual(2);
    }
    const iconStarts = [selected, unselected, command].map((item) => partBounds(item, "icon").left);
    expect(Math.max(...iconStarts) - Math.min(...iconStarts)).toBeLessThanOrEqual(1);
  });

  it.each(["cron", "usage"] as const)(
    "keeps %s filter checkmarks before aligned selected and unselected labels",
    async (owner) => {
      const view =
        owner === "cron"
          ? mountSolid(() =>
              createComponent(RunsSection, {
                runs: [],
                runsState: "ready",
                runsHasMore: false,
                runsLoadingMore: false,
                runsStatuses: ["error"],
                runsDeliveryStatuses: [],
                runsQuery: "",
                runsSortDir: "desc",
                onLoadMoreRuns: () => {},
                onRefresh: () => {},
                onRunsFiltersChange: () => {},
              }),
            )
          : mountSolid(() =>
              createComponent(UsageQueryFilter, {
                filterKey: "provider",
                label: "Provider",
                options: ["Alpha", "Beta"],
                queryDraft: "provider:Alpha",
                queryTerms: extractQueryTerms("provider:Alpha"),
                onQueryDraftChange: () => {},
              }),
            );
      flush();
      const container = view.container.querySelector<HTMLElement>(
        owner === "cron" ? '.cron-filter-dropdown[data-filter="status"]' : ".usage-filter-select",
      )!;
      const surface = await openMenu(container);
      const selected = surface.querySelector<HTMLElement>(
        '[role="menuitemcheckbox"][aria-checked="true"]',
      )!;
      const unselected = surface.querySelector<HTMLElement>(
        '[role="menuitemcheckbox"][aria-checked="false"]',
      )!;

      for (const item of [selected, unselected]) {
        const check = partBounds(item, "check");
        const label = partBounds(item, "label");
        expect(check.width).toBeGreaterThan(0);
        expect(label.width).toBeGreaterThan(0);
        expect(check.right).toBeLessThanOrEqual(label.left);
        expect(
          Math.abs(check.top + check.height / 2 - label.top - label.height / 2),
        ).toBeLessThanOrEqual(2);
      }
      expect(
        Math.abs(partBounds(selected, "label").left - partBounds(unselected, "label").left),
      ).toBeLessThanOrEqual(1);
    },
  );
});
