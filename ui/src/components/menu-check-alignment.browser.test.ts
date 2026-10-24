import { createComponent } from "solid-js";
import { describe, expect, it } from "vitest";
import { extractQueryTerms } from "../../../src/shared/usage-query.js";
import { registerUsageEnglish } from "../i18n/locales/en-usage.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { RunsSection } from "../pages/cron/view-runs.tsx";
import { createCronViewProps } from "../pages/cron/view.test-support.ts";
import { UsageQueryFilter } from "../pages/usage/view-query-filter.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { Menu } from "./solid/menu.tsx";
import "../styles.css";
import "../styles/cron.css";
import "../styles/usage.css";

registerEnglishCatalog(registerUsageEnglish);

const partBounds = (item: HTMLElement, part: "check" | "label" | "icon") =>
  item.querySelector<HTMLElement>(`.oc-menu-item__${part}`)!.getBoundingClientRect();

function expectCheckAlignment(items: HTMLElement[], trailing: boolean) {
  for (const item of items) {
    const check = partBounds(item, "check");
    const label = partBounds(item, "label");
    expect(Math.min(check.width, label.width)).toBeGreaterThan(0);
    const gap = trailing ? check.left - label.right : label.left - check.right;
    expect(gap).toBeGreaterThanOrEqual(0);
    const centerY = (rect: DOMRect) => rect.top + rect.height / 2;
    expect(Math.abs(centerY(check) - centerY(label))).toBeLessThanOrEqual(2);
  }
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

describe.skipIf(/jsdom/i.test(navigator.userAgent))("menu selection check alignment", () => {
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

    expectCheckAlignment([selected, unselected], true);
    const iconStarts = [selected, unselected, command].map((item) => partBounds(item, "icon").left);
    expect(Math.max(...iconStarts) - Math.min(...iconStarts)).toBeLessThanOrEqual(1);
  });

  it.each(["cron", "usage"] as const)("aligns %s leading checkmarks and labels", async (owner) => {
    const view = mountSolid(() =>
      owner === "cron"
        ? createComponent(RunsSection, createCronViewProps({ runsStatuses: ["error"] }))
        : createComponent(UsageQueryFilter, {
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
    const choice = (checked: boolean) =>
      surface.querySelector<HTMLElement>(`[role="menuitemcheckbox"][aria-checked="${checked}"]`)!;
    const [selected, unselected] = [choice(true), choice(false)] as const;

    expectCheckAlignment([selected, unselected], false);
    const delta = partBounds(selected, "label").left - partBounds(unselected, "label").left;
    expect(Math.abs(delta)).toBeLessThanOrEqual(1);
  });
});
