import { describe, expect, it, onTestFinished, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  loadStoredSidebarSessionsShowPreview,
  loadStoredSidebarSessionsShowSystem,
} from "./app-sidebar-session-types.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../test-helpers/load-styles.ts";
import "../styles/settings-controls.css";
import "../styles/settings-native-controls.css";
import "./app-sidebar.ts";

setupSidebarTest();

const ringStyle = (root: Element, selector: string) =>
  getComputedStyle(root.querySelector(selector)!).outlineStyle;
const ownerOptions = (root: Element) =>
  [
    ...root
      .querySelector("#sidebar-session-owner-title")!
      .closest("openclaw-select-picker")!
      .querySelectorAll<HTMLElement>(".picker-select__option:not([hidden]) .picker-select__label"),
  ].map((label) => label.textContent!.trim());

async function mountFilters(width: number, teammates = 0) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 560);
  // The app shell marks phone layouts; the filter panel becomes a bottom sheet there.
  document.body.classList.toggle("shell--mobile-nav", width < 560);
  onTestFinished(() => document.body.classList.remove("shell--mobile-nav"));
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  const sessions = createSessionsHarness("main", ["agent:main:ada", "agent:main:bob"]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "profile-ada", label: "Ada" },
    { type: "human", id: "profile-bob", label: "Bob" },
    ...Array.from({ length: teammates }, (_, index) => ({
      type: "human" as const,
      id: `profile-${index}`,
      label: `Teammate ${index}`,
    })),
  ];
  for (const [index, row] of result.sessions.entries()) {
    row.owner = { actor: result.owners[index]! };
    row.category = index === 0 ? "Research" : "Operations";
  }
  sessions.publish({ groups: ["Research", "Operations", "Empty"] });
  const mounted = await mountSidebar(
    gateway.gateway,
    sessions.sessions,
    width < 560 ? "drawer" : "panel",
  );
  mounted.provider.style.cssText = "display:block;width:300px;height:100vh";
  mounted.sidebar.setSessionOwnerFilter(null);
  await mounted.sidebar.updateComplete;
  return { ...mounted, sessions, page };
}

describe.runIf("__vitest_browser__" in globalThis)("sidebar session filter popover", () => {
  it.each([
    { width: 1440, direction: "ltr" },
    { width: 390, direction: "ltr" },
    { width: 390, direction: "rtl" },
  ])(
    "keeps keyboard navigation, focus and surface inside the viewport at $width px ($direction)",
    async ({ width, direction }) => {
      vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const { sidebar, page } = await mountFilters(width);
      sidebar.dir = direction;
      const occlusion: boolean[] = [];
      onTestFinished(
        subscribeNativeOverlayOcclusion(
          (value) => occlusion.push(value),
          () => new DOMRect(0, 0, innerWidth, innerHeight),
        ),
      );
      const { userEvent } = await import("vitest/browser");
      const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
      const active = page.getByRole("radio", { name: "Active", exact: true });
      const expectFits = async () => {
        const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel")!;
        await expect.element(menu).toBeVisible();
        // The phone sheet slides in; measure where it settles.
        await Promise.all(menu.getAnimations().map((animation) => animation.finished));
        const bounds = menu.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.height).toBeLessThanOrEqual(innerHeight);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(innerWidth);
        // Every row label shares one typography; section titles and values may differ.
        const labels = menu.querySelectorAll(
          ".sidebar-session-menu-row > :first-child, .sidebar-session-menu-switch > span:first-child, .picker-select__name, #sidebar-sessions-sources",
        );
        expect(
          new Set(
            [...labels].map((label) => {
              const style = getComputedStyle(label);
              return `${style.fontSize} ${style.fontWeight} ${style.color}`;
            }),
          ).size,
        ).toBe(1);
        const rows = [...menu.querySelectorAll<HTMLElement>(".sidebar-session-menu-row")];
        const controls = rows.map((row) => row.lastElementChild!.getBoundingClientRect());
        for (const [index, row] of rows.entries()) {
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
          expect(row.getBoundingClientRect().height).toBe(36);
          expect(controls[index]!.left).toBeCloseTo(controls[0]!.left, 1);
          expect(controls[index]!.right).toBeCloseTo(controls[0]!.right, 1);
        }
      };
      const owners = page.getByRole("button", { name: "Owners: All owners", exact: true });
      (owners.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("listbox", { name: "Owners", exact: true }))
        .toBeVisible();
      expect(ownerOptions(sidebar)).toEqual(["All owners", "Involving me", "My sessions", "Bob"]);
      const search = page.getByRole("combobox", { name: "Search", exact: true });
      await expect.element(search).toHaveFocus();
      expect(getComputedStyle(sidebar.querySelector(".picker-select__search")!).boxShadow).not.toBe(
        "none",
      );
      expect(ringStyle(sidebar, ".picker-select__option[data-active]")).not.toBe("none");
      await userEvent.keyboard("bo");
      await expect.poll(() => ownerOptions(sidebar)).toEqual(["Bob"]);
      await userEvent.keyboard("{Escape}");
      await expect.element(search).toHaveValue("");
      await expect.poll(() => ownerOptions(sidebar)).toHaveLength(4);
      await userEvent.keyboard("{Escape}");
      await expect.element(owners).toHaveFocus();
      await trigger.click();
      await expect.poll(() => occlusion).toEqual([false, true]);
      await expectFits();
      await expect.element(active).toHaveFocus();
      await userEvent.keyboard(direction === "rtl" ? "{ArrowLeft}" : "{ArrowRight}");
      await expect.element(page.getByRole("radio", { name: "Snoozed", exact: true })).toHaveFocus();
      expect(loadStoredSidebarSessionStatusFilter()).toBe("snoozed");
      await userEvent.keyboard(direction === "rtl" ? "{ArrowLeft}" : "{ArrowRight}");
      await expect
        .element(page.getByRole("radio", { name: "Archived", exact: true }))
        .toHaveFocus();
      expect(loadStoredSidebarSessionStatusFilter()).toBe("archived");
      await userEvent.tab();
      await expect
        .element(page.getByRole("switch", { name: "Show automation sessions", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("switch", { name: "Show system sessions", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("button", { name: "Group by: Custom groups", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard(direction === "rtl" ? "{ArrowLeft}" : "{ArrowRight}");
      const choices = sidebar.querySelector<HTMLElement>(
        '[role="listbox"][aria-label="Group by"]',
      )!;
      await expect.element(choices).toBeVisible();
      await expect
        .poll(() => {
          const bounds = choices.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight
          );
        })
        .toBe(true);
      await userEvent.keyboard(direction === "rtl" ? "{ArrowRight}" : "{ArrowLeft}");
      await expect
        .element(page.getByRole("button", { name: "Group by: Custom groups", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
      await expect.poll(loadStoredSidebarSessionsGrouping).toBe("project");
      await userEvent.tab();
      await expect
        .element(page.getByRole("button", { name: "Sort by: Created", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
      await expect.poll(loadStoredSidebarSessionSortMode).toBe("updated");
      await userEvent.tab();
      await expect
        .element(
          page.getByRole("button", { name: "Hide empty groups: When filtering", exact: true }),
        )
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("switch", { name: "Show message preview", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("link", { name: "Session sources", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false]);
      await trigger.click();
      await expect
        .element(page.getByRole("radio", { name: "Archived", exact: true }))
        .toHaveFocus();
      await expect.poll(() => occlusion).toEqual([false, true, false, true]);
      // The phone sheet covers the toolbar; its backdrop dismisses it instead.
      if (width < 560) {
        sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel__backdrop")!.click();
      } else {
        await trigger.click();
      }
      await expect.poll(() => sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false, true, false]);
    },
  );

  it("opens display submenus on mouse hover and leaves touch on click", async () => {
    const { sidebar, page } = await mountFilters(1440);
    const { userEvent } = await import("vitest/browser");
    const settle = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const sort = page.getByRole("button", { name: "Sort by: Created", exact: true });
    const sortRow = sidebar.querySelector<HTMLElement>("#sidebar-sessions-sort")!.parentElement!;
    sortRow.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    await settle();
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
    await userEvent.hover(sort);
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await userEvent.hover(page.getByRole("option", { name: "Last updated", exact: true }));
    await settle();
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await userEvent.hover(page.getByRole("heading", { name: "Filters", exact: true }));
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
  });

  it("presents a bottom sheet with choice pages on phones", async () => {
    const { provider, sidebar, page } = await mountFilters(390);
    // The real mobile drawer is focusable. Unfocusable sheet content must not
    // send focus back to that ancestor and dismiss the panel before click.
    provider.tabIndex = -1;
    const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
    await trigger.click();
    const panel = sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel")!;
    await expect.element(panel).toBeVisible();
    await Promise.all(panel.getAnimations().map((animation) => animation.finished));
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(sidebar.querySelector(".sidebar-session-sort-menu wa-popup")).toBeNull();
    const sheet = panel.getBoundingClientRect();
    expect(sheet.left).toBe(0);
    expect(sheet.width).toBe(innerWidth);
    expect(sheet.bottom).toBeCloseTo(innerHeight, 0);
    await page.getByRole("heading", { name: "Filters", exact: true }).click();
    const automation = page.getByRole("switch", { name: "Show automation sessions", exact: true });
    await automation.click();
    await expect.element(automation).toHaveAttribute("aria-checked", "true");
    // A choice opens as a page covering the sheet, with Back and a title.
    await page.getByRole("button", { name: "Group by: Custom groups", exact: true }).click();
    const choices = sidebar.querySelector<HTMLElement>('[role="listbox"][aria-label="Group by"]')!;
    await expect.element(choices).toBeVisible();
    const choicePage = choices.closest<HTMLElement>(".picker-select__menu")!;
    await Promise.all(choicePage.getAnimations().map((animation) => animation.finished));
    const pageBounds = choicePage.getBoundingClientRect();
    expect(pageBounds.left).toBe(sheet.left);
    expect(pageBounds.right).toBe(sheet.right);
    const back = page.getByRole("button", { name: "Back", exact: true });
    await expect.element(back).toHaveFocus();
    await back.click();
    await expect.element(choices).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Group by: Custom groups", exact: true }).click();
    await page.getByRole("option", { name: "Project", exact: true }).click();
    expect(loadStoredSidebarSessionsGrouping()).toBe("project");
    await expect
      .element(page.getByRole("button", { name: "Group by: Project", exact: true }))
      .toBeVisible();
    // Tapping exposed backdrop space dismisses the sheet, like the issues sheet.
    await page.getByRole("button", { name: "Close", exact: true }).click({
      position: { x: 10, y: 10 },
    });
    await expect.poll(() => sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
    await expect.element(trigger).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside the phone sheet", async () => {
    const { sidebar, page } = await mountFilters(390);
    const { userEvent } = await import("vitest/browser");
    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const owners = page.getByRole("radio", { name: "Active", exact: true });
    const sources = page.getByRole("link", { name: "Session sources", exact: true });
    await expect.element(owners).toHaveFocus();
    // The backdrop stays a pointer target, not a tab stop.
    const backdrop = sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel__backdrop")!;
    expect(backdrop.tabIndex).toBe(-1);
    await userEvent.tab({ shift: true });
    await expect.element(sources).toHaveFocus();
    await userEvent.tab();
    await expect.element(owners).toHaveFocus();
    // After touching noninteractive content, Tab must stay inside the sheet.
    await page.getByRole("heading", { name: "Filters", exact: true }).click();
    await userEvent.tab({ shift: true });
    await expect.element(sources).toHaveFocus();
    await page.getByRole("heading", { name: "Filters", exact: true }).click();
    await userEvent.tab();
    await expect.element(owners).toHaveFocus();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).not.toBeNull();
    await expect
      .element(sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel")!)
      .toBeVisible();
  });

  it("fades the owner list at the edges it scrolls past", async () => {
    const { sidebar, page } = await mountFilters(1440, 30);
    await page.getByRole("button", { name: "Owners: All owners", exact: true }).click();
    const list = sidebar.querySelector<HTMLElement>('[role="listbox"][aria-label="Owners"]')!;
    await expect.element(list).toBeVisible();
    await expect.poll(() => list.hasAttribute("data-fade-end")).toBe(true);
    expect(list.hasAttribute("data-fade-start")).toBe(false);
    expect(getComputedStyle(list).maskImage).not.toBe("none");
    list.scrollTop = list.scrollHeight;
    await expect.poll(() => list.hasAttribute("data-fade-start")).toBe(true);
    expect(list.hasAttribute("data-fade-end")).toBe(false);
  });

  it.each([1440, 390])(
    "resets each Display choice without a filter dot at %i px",
    async (width) => {
      const { sidebar, page } = await mountFilters(width);
      await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
      const menu = sidebar.querySelector(".sidebar-session-sort-menu");
      for (const [label, choice, defaultValue] of [
        ["Group by", "Person", "Custom groups"],
        ["Sort by", "Last updated", "Created"],
        ["Hide empty groups", "Always", "When filtering"],
        ["Show message preview", null, null],
      ] as const) {
        if (choice) {
          await page
            .getByRole("button", { name: label + ": " + defaultValue, exact: true })
            .click();
          await page.getByRole("option", { name: choice, exact: true }).click();
        } else {
          await page.getByRole("switch", { name: label, exact: true }).click();
        }
        await sidebar.updateComplete;
        const trigger = sidebar.querySelector(".sidebar-session-sort")!;
        expect(trigger.classList.contains("sidebar-session-sort--filtered")).toBe(false);
        expect(trigger.hasAttribute("aria-description")).toBe(false);
        expect(sidebar.querySelector("#sidebar-sessions-reset"), label).not.toBeNull();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        expect(loadStoredSidebarSessionsGrouping()).toBe("category");
        expect(loadStoredSidebarSessionSortMode()).toBe("created");
        expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
        if (choice) {
          await expect
            .element(page.getByRole("button", { name: label + ": " + defaultValue, exact: true }))
            .toBeVisible();
        } else {
          await expect
            .element(page.getByRole("switch", { name: label, exact: true }))
            .toHaveAttribute("aria-checked", "false");
        }
        expect(sidebar.querySelector("#sidebar-sessions-reset")).toBeNull();
        expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
        await expect
          .element(page.getByRole("radio", { name: "Active", exact: true }))
          .toHaveFocus();
      }
    },
  );

  it.each(["roster", "owners"] as const)(
    "preserves hidden grouping preferences across reset when %s hides them",
    async (hiddenBy) => {
      const { sidebar, sessions, page } = await mountFilters(1440);
      const original = sessions.sessions.state.result!;
      const grouping = hiddenBy === "roster" ? "project" : "person";
      if (hiddenBy === "roster") {
        sidebar.sessionOrganizer.setSessionsGrouping(grouping);
        await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
        await page.getByRole("button", { name: /^Hide empty groups:/ }).click();
        await page.getByRole("option", { name: "Never", exact: true }).click();
        sidebar.dismissTransientMenus();
        sidebar.sidebarAgentsMode = "roster";
        await sidebar.updateComplete;
        await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
        expect(sidebar.querySelector("#sidebar-sessions-group")).toBeNull();
        expect(sidebar.querySelector("#sidebar-sessions-empty")).toBeNull();
      } else {
        await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
        await page.getByRole("button", { name: "Group by: Custom groups", exact: true }).click();
        await page.getByRole("option", { name: "Person", exact: true }).click();
        sessions.publish({ result: { ...original, owners: original.owners!.slice(0, 1) } });
        await expect
          .element(page.getByRole("button", { name: "Group by: Custom groups", exact: true }))
          .toBeVisible();
        expect(loadStoredSidebarSessionsGrouping()).toBe("person");
      }
      expect(sidebar.querySelector("#sidebar-sessions-reset")).toBeNull();
      await page.getByRole("switch", { name: "Show message preview", exact: true }).click();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
      expect(loadStoredSidebarSessionsGrouping()).toBe(grouping);
      if (hiddenBy === "roster") {
        expect(sidebar.querySelector("#sidebar-sessions-reset")).toBeNull();
        sidebar.sidebarAgentsMode = "chip";
        await sidebar.updateComplete;
        await expect
          .element(page.getByRole("button", { name: "Hide empty groups: Never", exact: true }))
          .toBeVisible();
      } else {
        sessions.publish({ result: original });
        await expect
          .element(page.getByRole("button", { name: "Group by: Person", exact: true }))
          .toBeVisible();
        expect(sidebar.querySelector("#sidebar-sessions-reset")).not.toBeNull();
      }
    },
  );

  it.each([
    { ownerId: "profile-ada", selected: "My sessions", label: "My sessions" },
    { ownerId: "profile-bob", selected: "Bob", label: "profile-bob" },
  ])(
    "keeps the selected owner display for an empty Archived list ($ownerId)",
    async ({ ownerId, selected, label }) => {
      const { sidebar, sessions, page } = await mountFilters(1440);
      await page.getByRole("button", { name: "Owners: All owners", exact: true }).click();
      await page.getByRole("option", { name: selected, exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: `Owners: ${selected}`, exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
      sessions.list.mockResolvedValue({
        ...sessions.sessions.state.result!,
        sessions: [],
        // An unresolved facet keeps the explicit owner selected without inventing a name.
        owners: ownerId === "profile-ada" ? [] : undefined,
      });
      await page.getByRole("radio", { name: "Archived", exact: true }).click();
      await expect
        .element(page.getByRole("radio", { name: "Archived", exact: true }))
        .toBeChecked();
      await expect.poll(() => sidebar.sessionData.sessionsResult?.sessions).toEqual([]);
      await expect
        .element(page.getByRole("button", { name: `Owners: ${label}`, exact: true }))
        .toBeVisible();
      expect(sessions.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerId, archivedFilter: "archived" }),
      );
      await page.getByRole("button", { name: `Owners: ${label}`, exact: true }).click();
      expect(ownerOptions(sidebar)).toEqual(["All owners", "Involving me", label]);
    },
  );

  it("applies every preference instantly and resets filters and display", async () => {
    const { sidebar, page } = await mountFilters(1440);
    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu")!;
    // The toolbar dot and its description track Status only; Reset
    // also appears for automation, system, and Display choices.
    const expectFilterCount = async (count: number, resetVisible = count > 0) => {
      await expect
        .poll(() =>
          sidebar.querySelector(".sidebar-session-sort")?.getAttribute("aria-description"),
        )
        .toBe(count ? `Active filters: ${count}` : null);
      expect(
        sidebar
          .querySelector(".sidebar-session-sort")
          ?.classList.contains("sidebar-session-sort--filtered"),
      ).toBe(count > 0);
      expect(sidebar.querySelector(".sidebar-session-sort")?.textContent?.trim()).toBe("");
      expect(sidebar.querySelector("#sidebar-sessions-reset") !== null).toBe(resetVisible);
    };
    await expectFilterCount(0);
    await page.getByRole("button", { name: "Group by: Custom groups", exact: true }).click();
    await page.getByRole("option", { name: "Person", exact: true }).click();
    expect(loadStoredSidebarSessionsGrouping()).toBe("person");
    await expectFilterCount(0, true);
    for (const [choice, expected, read] of [
      ["Owners", "people", loadStoredSidebarSessionSortMode],
      ["All", "all", loadStoredSidebarSessionStatusFilter],
    ] as const) {
      if (choice === "Owners") {
        await page.getByRole("button", { name: /^Sort by:/ }).click();
        await page.getByRole("option", { name: choice, exact: true }).click();
      } else {
        await page.getByRole("radio", { name: choice, exact: true }).click();
      }
      expect(read()).toBe(expected);
      await expectFilterCount(choice === "All" ? 1 : 0, true);
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    }
    for (const [name, read] of [
      ["Show message preview", loadStoredSidebarSessionsShowPreview],
      ["Show automation sessions", loadStoredSidebarSessionsShowCron],
      ["Show system sessions", loadStoredSidebarSessionsShowSystem],
    ] as const) {
      const before = read();
      await page.getByRole("switch", { name, exact: true }).click();
      expect(read()).toBe(!before);
      // Only Status lights the toolbar dot.
      await expectFilterCount(1);
    }
    expect(menu.querySelector("#sidebar-sessions-owner")).toBeNull();
    await page.getByRole("button", { name: /^Hide empty groups:/ }).click();
    await page.getByRole("option", { name: "Never", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    expect(sidebar.sessionOwnerFilterId).toBeNull();
    expect(loadStoredSidebarSessionsShowCron()).toBe(false);
    expect(loadStoredSidebarSessionsShowSystem()).toBe(false);
    expect(loadStoredSidebarSessionsGrouping()).toBe("category");
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
    await expect
      .element(page.getByRole("button", { name: "Hide empty groups: When filtering", exact: true }))
      .toBeVisible();
    await expectFilterCount(0);
    await expect.element(page.getByRole("radio", { name: "Active", exact: true })).toHaveFocus();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    await page.getByRole("switch", { name: "Show automation sessions", exact: true }).click();
    await expectFilterCount(0, true);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(loadStoredSidebarSessionsShowCron()).toBe(false);
    await expectFilterCount(0);
    await page.getByRole("button", { name: /^Hide empty groups:/ }).click();
    await page.getByRole("option", { name: "Always", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).toBeNull();
    await page.getByRole("button", { name: /^Hide empty groups:/ }).click();
    await page.getByRole("option", { name: "Never", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).not.toBeNull();
  });
});
