import { describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
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
import { setSessionsGrouping } from "./session-organizer-menu.runtime.ts";
import "../test-helpers/load-styles.ts";
import "../styles/settings-controls.css";
import "../styles/sidebar-rail.css";
import "../styles/settings-native-controls.css";
import "./app-sidebar.tsx";

setupSidebarTest();

const ringStyle = (root: Element, selector: string) =>
  getComputedStyle(root.querySelector(selector)!).outlineStyle;
const finishAnimations = (element: Element) =>
  Promise.all(element.getAnimations().map((animation) => animation.finished));
function mockNative() {
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}
function nativeOcclusion() {
  const values: boolean[] = [];
  onTestFinished(
    subscribeNativeOverlayOcclusion(
      (value) => values.push(value),
      () => new DOMRect(0, 0, innerWidth, innerHeight),
    ),
  );
  return values;
}
const ownerOptions = (root: Element) =>
  [
    ...root
      .querySelector("#sidebar-session-owner-title")!
      .closest("openclaw-select-picker")!
      .querySelectorAll<HTMLElement>(".picker-select__option:not([hidden]) .picker-select__label"),
  ].map((label) => label.textContent!.trim());

async function mountFilters(width: number, teammates = 0, otherOwner = "Bob") {
  const { page, userEvent } = await import("vitest/browser");
  const role = (kind: Parameters<typeof page.getByRole>[0], name: string | RegExp) =>
    page.getByRole(kind, { name, exact: true });
  await page.viewport(width, 560);
  // Park before mounting: a previous case's pointer can otherwise reveal a
  // tooltip while the new sidebar settles, before keyboard actions begin.
  await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
  document.body.classList.toggle("shell--mobile-nav", width < 560);
  onTestFinished(() => document.body.classList.remove("shell--mobile-nav"));
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  const sessions = createSessionsHarness("main", ["agent:main:ada", "agent:main:bob"]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "profile-ada", label: "Ada" },
    { type: "human", id: "profile-bob", label: otherOwner },
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
  const query = (selector: string) => mounted.sidebar.querySelector<HTMLElement>(selector)!;
  const choose = async (label: string | RegExp, value: string) => {
    await role("button", label).click();
    await role("option", value).click();
  };
  const tabTo = async (kind: Parameters<typeof role>[0], name: string) => {
    await userEvent.tab();
    await expect.element(role(kind, name)).toHaveFocus();
  };
  return { ...mounted, sessions, page, userEvent, role, query, choose, tabTo };
}

describe.runIf("__vitest_browser__" in globalThis)("sidebar session filter popover", () => {
  it("keeps a long selected owner clear of toolbar controls", async () => {
    const name = "Alexandria Montgomery Engineering";
    const { query, choose } = await mountFilters(390, 0, name);
    await choose("Owners: All owners", name);
    const owner = query(".sidebar-session-owner-filter");
    const sort = query(".sidebar-session-sort");
    expect(owner.getBoundingClientRect().right).toBeLessThanOrEqual(
      sort.getBoundingClientRect().left,
    );
    expect(sort.getBoundingClientRect().right).toBeLessThanOrEqual(
      query(".sidebar-session-toolbar").getBoundingClientRect().right,
    );
    const label = owner.querySelector<HTMLElement>(".picker-select__label")!;
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
  });

  it.each([
    { width: 1440, direction: "ltr" },
    { width: 390, direction: "ltr" },
    { width: 390, direction: "rtl" },
  ])(
    "keeps keyboard navigation, focus and surface inside the viewport at $width px ($direction)",
    async ({ width, direction }) => {
      mockNative();
      const { sidebar, page, userEvent, role, query, tabTo } = await mountFilters(width);
      // A retained pointer can open the rail tooltip when the layout switches to RTL.
      await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
      sidebar.dir = direction;
      const occlusion = nativeOcclusion();
      expect(occlusion).toEqual([false]);
      const trigger = role("button", /^Filter & sort · /);
      const active = role("radio", "Active");
      const expectFits = async () => {
        const menu = query(".sidebar-session-filter-panel")!;
        await expect.element(menu).toBeVisible();
        await finishAnimations(menu);
        const bounds = menu.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.height).toBeLessThanOrEqual(innerHeight);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(innerWidth);
        const labels = menu.querySelectorAll(
          ".sidebar-session-menu-row > :first-child, .sidebar-session-menu-switch > span:first-child, .picker-select__name, #sidebar-sessions-sources",
        );
        const typography = [...labels].map((label) => {
          const { fontSize, fontWeight, color } = getComputedStyle(label);
          return `${fontSize} ${fontWeight} ${color}`;
        });
        expect(new Set(typography).size).toBe(1);
        const rows = [...menu.querySelectorAll<HTMLElement>(".sidebar-session-menu-row")];
        const controls = rows.map((row) => row.lastElementChild!.getBoundingClientRect());
        for (const [index, row] of rows.entries()) {
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
          expect(row.getBoundingClientRect().height).toBe(width <= 640 ? 42 : 36);
          expect(controls[index]!.left).toBeCloseTo(controls[0]!.left, 1);
          expect(controls[index]!.right).toBeCloseTo(controls[0]!.right, 1);
        }
      };
      const owners = role("button", "Owners: All owners");
      (owners.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(role("listbox", "Owners")).toBeVisible();
      expect(ownerOptions(sidebar)).toEqual(["All owners", "Involving me", "My sessions", "Bob"]);
      const ownersSurface = role("listbox", "Owners").element().closest(".picker-select__menu")!;
      // Native overlap can change during the sheet's slide-in; sample close/open edges after entry.
      await finishAnimations(ownersSurface);
      await expect.poll(() => occlusion.at(-1)).toBe(true);
      const occlusionAfterOpening = occlusion.length;
      const occlusionTail = () => occlusion.slice(occlusionAfterOpening);
      await expect.poll(() => query(".picker-select__option[data-active]")).not.toBeNull();
      expect(ringStyle(sidebar, ".picker-select__option[data-active]")).not.toBe("none");
      await userEvent.keyboard("bo");
      await expect.poll(() => ownerOptions(sidebar)).toEqual(["Bob"]);
      await expect.element(role("combobox", "Search")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(query(".picker-select__search")).toBeNull();
      await expect.poll(() => ownerOptions(sidebar)).toHaveLength(4);
      // Focus returns before the closing frame releases native occlusion.
      const ownersHidden = new Promise<void>((resolve) => {
        ownersSurface.addEventListener("overlay-after-hide", () => resolve(), { once: true });
      });
      await userEvent.keyboard("{Escape}");
      await ownersHidden;
      await expect.element(owners).toHaveFocus();
      expect(occlusionTail()).toEqual([false]);
      await trigger.click();
      await expect.poll(occlusionTail).toEqual([false, true]);
      await expectFits();
      await expect.element(active).toHaveFocus();
      const forward = direction === "rtl" ? "{ArrowLeft}" : "{ArrowRight}";
      for (const status of ["Snoozed", "Archived"]) {
        await userEvent.keyboard(forward);
        await expect.element(role("radio", status)).toHaveFocus();
        expect(loadStoredSidebarSessionStatusFilter()).toBe(status.toLowerCase());
      }
      await tabTo("switch", "Show automation sessions");
      await tabTo("switch", "Show system sessions");
      await tabTo("button", "Group by: Custom groups");
      await userEvent.keyboard(forward);
      const choices = query('[role="listbox"][aria-label="Group by"]')!;
      await expect.element(choices).toBeVisible();
      await expect
        .poll(() => {
          const { left, right, top, bottom } = choices.getBoundingClientRect();
          return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
        })
        .toBe(true);
      await userEvent.keyboard(direction === "rtl" ? "{ArrowRight}" : "{ArrowLeft}");
      await expect.element(role("button", "Group by: Custom groups")).toHaveFocus();
      await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
      await expect.poll(loadStoredSidebarSessionsGrouping).toBe("project");
      await tabTo("button", "Sort by: Created");
      await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
      await expect.poll(loadStoredSidebarSessionSortMode).toBe("updated");
      await tabTo("button", "Hide empty groups: When filtering");
      await tabTo("switch", "Show message preview");
      await tabTo("link", "Session sources");
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      expect(query(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(occlusionTail).toEqual([false, true, false]);
      await trigger.click();
      await expect.element(role("radio", "Archived")).toHaveFocus();
      await expect.poll(occlusionTail).toEqual([false, true, false, true]);
      // The phone sheet covers the toolbar; its backdrop dismisses it instead.
      if (width < 560) {
        query(".sidebar-session-filter-panel__backdrop")!.click();
      } else {
        await trigger.click();
      }
      await expect.poll(() => query(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(occlusionTail).toEqual([false, true, false, true, false]);
    },
  );

  it("moves long translated status options onto their own line instead of cutting them", async () => {
    onTestFinished(captureI18nStateForTesting());
    await i18n.setLocale("de");
    const { sidebar, page } = await mountFilters(1440);
    await page
      .getByRole("button", {
        name: `${t("chat.sidebar.sortSessions")} · ${t("common.active")}`,
        exact: true,
      })
      .click();
    const row = sidebar.querySelector<HTMLElement>("#sidebar-sessions-status")!;
    await expect.element(row).toBeVisible();
    const rowBounds = row.getBoundingClientRect();
    const group = row.querySelector<HTMLElement>(".sidebar-session-menu-segmented")!;
    const groupBounds = group.getBoundingClientRect();
    const options = [...group.querySelectorAll<HTMLElement>(".settings-segmented__btn")];
    expect(options.map((option) => option.textContent)).toEqual([
      "Aktiv",
      "Zurückgestellt",
      "Archiviert",
      "Alle",
    ]);
    for (const option of options) {
      const bounds = option.getBoundingClientRect();
      expect(option.scrollWidth).toBeLessThanOrEqual(option.clientWidth);
      expect(bounds.top).toBeGreaterThanOrEqual(groupBounds.top);
      expect(bounds.bottom).toBeLessThanOrEqual(groupBounds.bottom);
      expect(bounds.right).toBeLessThanOrEqual(groupBounds.right);
    }
    // The control takes the full row below its label and the next row starts after it.
    expect(groupBounds.top).toBeGreaterThan(row.firstElementChild!.getBoundingClientRect().top);
    expect(groupBounds.bottom).toBeLessThanOrEqual(rowBounds.bottom);
    expect(row.nextElementSibling!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      rowBounds.bottom,
    );
  });

  it("opens display submenus on mouse hover and leaves touch on click", async () => {
    const { role, query, userEvent } = await mountFilters(1440);
    await role("button", /^Filter & sort · /).click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const settle = () => vi.advanceTimersByTimeAsync(300);
    const sort = role("button", "Sort by: Created");
    const sortRow = query("#sidebar-sessions-sort")!.parentElement!;
    sortRow.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    await settle();
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
    await userEvent.hover(sort);
    await settle();
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await userEvent.hover(role("option", "Last updated"));
    await settle();
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await userEvent.hover(role("heading", "Filters"));
    await settle();
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "true");
    await sort.click();
    await expect.element(sort).toHaveAttribute("aria-expanded", "false");
  });

  it("presents a bottom sheet with choice pages on phones", async () => {
    const { provider, role, query, tabTo, userEvent } = await mountFilters(390);
    // The real mobile drawer is focusable. Unfocusable sheet content must not
    // send focus back to that ancestor and dismiss the panel before click.
    provider.tabIndex = -1;
    const trigger = role("button", /^Filter & sort · /);
    await trigger.click();
    const panel = query(".sidebar-session-filter-panel")!;
    await expect.element(panel).toBeVisible();
    await finishAnimations(panel);
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.matches(":popover-open")).toBe(true);
    const sheet = panel.getBoundingClientRect();
    expect(sheet).toMatchObject({ left: 0, width: innerWidth });
    expect(sheet.bottom).toBeCloseTo(innerHeight, 0);

    const owners = role("radio", "Active");
    const sources = role("link", "Session sources");
    await expect.element(owners).toHaveFocus();
    const backdrop = query(".sidebar-session-filter-panel__backdrop")!;
    expect(backdrop.tabIndex).toBe(-1);
    await userEvent.tab({ shift: true });
    await expect.element(sources).toHaveFocus();
    await userEvent.tab();
    await expect.element(owners).toHaveFocus();
    await role("heading", "Filters").click();
    await userEvent.tab({ shift: true });
    await expect.element(sources).toHaveFocus();
    await role("heading", "Filters").click();
    await userEvent.tab();
    await expect.element(owners).toHaveFocus();
    expect(query(".sidebar-session-sort-menu")).not.toBeNull();
    await expect.element(query(".sidebar-session-filter-panel")!).toBeVisible();

    // A closed Solid picker must not shrink the outer sheet's Tab boundary to itself.
    const grouping = query("#sidebar-sessions-group")!;
    grouping.focus();
    await tabTo("button", "Sort by: Created");
    await userEvent.tab({ shift: true });
    await expect.element(grouping).toHaveFocus();
    await role("heading", "Filters").click();
    const automation = role("switch", "Show automation sessions");
    await automation.click();
    await expect.element(automation).toHaveAttribute("aria-checked", "true");
    const groupBy = role("button", "Group by: Custom groups");
    await groupBy.click();
    const choices = query('[role="listbox"][aria-label="Group by"]')!;
    await expect.element(choices).toBeVisible();
    const choicePage = choices.closest<HTMLElement>(".picker-select__menu")!;
    await finishAnimations(choicePage);
    expect(choicePage.getBoundingClientRect()).toMatchObject({
      left: sheet.left,
      right: sheet.right,
    });
    const back = role("button", "Back");
    await expect.element(back).toHaveFocus();
    await back.click();
    await expect.element(choicePage).not.toBeVisible();
    await expect.element(groupBy).toHaveAttribute("aria-expanded", "false");
    await expect.element(groupBy).toHaveFocus();
    await groupBy.click();
    await role("option", "Project").click();
    expect(loadStoredSidebarSessionsGrouping()).toBe("project");
    await expect.element(role("button", "Group by: Project")).toBeVisible();
    await role("button", "Close").click({ position: { x: 10, y: 10 } });
    await expect.poll(() => query(".sidebar-session-sort-menu")).toBeNull();
    await expect.element(trigger).toHaveFocus();
  });

  it("fades the owner list at the edges it scrolls past", async () => {
    const { role, query } = await mountFilters(1440, 30);
    await role("button", "Owners: All owners").click();
    const list = query('[role="listbox"][aria-label="Owners"]')!;
    await expect.element(list).toBeVisible();
    await expect.poll(() => list.hasAttribute("data-fade-end")).toBe(true);
    expect(list.hasAttribute("data-fade-start")).toBe(false);
    expect(getComputedStyle(list).maskImage).not.toBe("none");
    list.scrollTop = list.scrollHeight;
    await expect.poll(() => list.hasAttribute("data-fade-start")).toBe(true);
    expect(list.hasAttribute("data-fade-end")).toBe(false);
  });

  it.each([390])("resets each Display choice without a filter dot at %i px", async (width) => {
    const { sidebar, role, query, choose } = await mountFilters(width);
    await role("button", /^Filter & sort · /).click();
    const menu = query(".sidebar-session-sort-menu");
    for (const [label, choice, defaultValue] of [
      ["Group by", "Person", "Custom groups"],
      ["Sort by", "Last updated", "Created"],
      ["Hide empty groups", "Always", "When filtering"],
      ["Show message preview", null, null],
    ] as const) {
      if (choice) {
        await choose(label + ": " + defaultValue, choice);
      } else {
        await role("switch", label).click();
      }
      await sidebar.updateComplete;
      const trigger = query(".sidebar-session-sort")!;
      expect(trigger.classList.contains("sidebar-session-sort--filtered")).toBe(false);
      expect(trigger.getAttribute("aria-description")).toBe("Status: Active");
      expect(query("#sidebar-sessions-reset"), label).not.toBeNull();
      await role("button", "Reset").click();
      expect(loadStoredSidebarSessionsGrouping()).toBe("category");
      expect(loadStoredSidebarSessionSortMode()).toBe("created");
      expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
      if (choice) {
        await expect.element(role("button", label + ": " + defaultValue)).toBeVisible();
      } else {
        await expect.element(role("switch", label)).toHaveAttribute("aria-checked", "false");
      }
      expect(query("#sidebar-sessions-reset")).toBeNull();
      expect(query(".sidebar-session-sort-menu")).toBe(menu);
      await expect.element(role("radio", "Active")).toHaveFocus();
    }
  });

  it.each(["roster", "owners"] as const)(
    "preserves hidden grouping preferences across reset when %s hides them",
    async (hiddenBy) => {
      const { sidebar, sessions, role, query, choose } = await mountFilters(1440);
      const original = sessions.sessions.state.result!;
      const grouping = hiddenBy === "roster" ? "project" : "person";
      if (hiddenBy === "roster") {
        setSessionsGrouping(sidebar.sessionOrganizer, grouping);
        await role("button", /^Filter & sort · /).click();
        await choose(/^Hide empty groups:/, "Never");
        sidebar.dismissTransientMenus();
        sidebar.sidebarAgentsMode = "roster";
        await sidebar.updateComplete;
        await role("button", /^Filter & sort · /).click();
        expect(query("#sidebar-sessions-group")).toBeNull();
        expect(query("#sidebar-sessions-empty")).toBeNull();
      } else {
        await role("button", /^Filter & sort · /).click();
        await choose("Group by: Custom groups", "Person");
        sessions.publish({ result: { ...original, owners: original.owners!.slice(0, 1) } });
        await expect.element(role("button", "Group by: Custom groups")).toBeVisible();
        expect(loadStoredSidebarSessionsGrouping()).toBe("person");
      }
      expect(query("#sidebar-sessions-reset")).toBeNull();
      await role("switch", "Show message preview").click();
      await role("button", "Reset").click();
      expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
      expect(loadStoredSidebarSessionsGrouping()).toBe(grouping);
      if (hiddenBy === "roster") {
        expect(query("#sidebar-sessions-reset")).toBeNull();
        sidebar.sidebarAgentsMode = "chip";
        await sidebar.updateComplete;
        await expect.element(role("button", "Hide empty groups: Never")).toBeVisible();
      } else {
        sessions.publish({ result: original });
        await expect.element(role("button", "Group by: Person")).toBeVisible();
        expect(query("#sidebar-sessions-reset")).not.toBeNull();
      }
    },
  );

  it.each([
    { ownerId: "profile-ada", selected: "My sessions", label: "My sessions" },
    { ownerId: "profile-bob", selected: "Bob", label: "profile-bob" },
  ])(
    "keeps the selected owner display for an empty Archived list ($ownerId)",
    async ({ ownerId, selected, label }) => {
      const { sidebar, sessions, role, choose } = await mountFilters(1440);
      await choose("Owners: All owners", selected);
      await expect.element(role("button", `Owners: ${selected}`)).toBeVisible();
      await role("button", /^Filter & sort · /).click();
      sessions.list.mockResolvedValue({
        ...sessions.sessions.state.result!,
        sessions: [],
        // An unresolved facet keeps the explicit owner selected without inventing a name.
        owners: ownerId === "profile-ada" ? [] : undefined,
      });
      await role("radio", "Archived").click();
      await expect.element(role("radio", "Archived")).toBeChecked();
      await expect.poll(() => sidebar.sessionData.sessionsResult?.sessions).toEqual([]);
      await expect.element(role("button", `Owners: ${label}`)).toBeVisible();
      expect(sessions.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerId, archivedFilter: "archived" }),
      );
      await role("button", `Owners: ${label}`).click();
      expect(ownerOptions(sidebar)).toEqual(["All owners", "Involving me", label]);
    },
  );

  it("applies every preference instantly and resets filters and display", async () => {
    const { sidebar, page, role, query, choose } = await mountFilters(1440);
    await role("button", /^Filter & sort · /).click();
    const menu = query(".sidebar-session-sort-menu")!;
    const expectFilterCount = async (count: number, resetVisible = count > 0) => {
      const trigger = () => query(".sidebar-session-sort");
      await expect
        .poll(() => trigger()?.getAttribute("aria-description"))
        .toBe(count ? "Status: All" : "Status: Active");
      expect(trigger()?.classList.contains("sidebar-session-sort--filtered")).toBe(count > 0);
      expect(query("#sidebar-sessions-reset") !== null).toBe(resetVisible);
    };
    await expectFilterCount(0);
    await choose("Group by: Custom groups", "Person");
    expect(loadStoredSidebarSessionsGrouping()).toBe("person");
    await expectFilterCount(0, true);
    for (const [choice, expected, read] of [
      ["Owners", "people", loadStoredSidebarSessionSortMode],
      ["All", "all", loadStoredSidebarSessionStatusFilter],
    ] as const) {
      if (choice === "Owners") {
        await choose(/^Sort by:/, choice);
      } else {
        await role("radio", choice).click();
      }
      expect(read()).toBe(expected);
      await expectFilterCount(choice === "All" ? 1 : 0, true);
      expect(query(".sidebar-session-sort-menu")).toBe(menu);
    }
    for (const [name, read] of [
      ["Show message preview", loadStoredSidebarSessionsShowPreview],
      ["Show automation sessions", loadStoredSidebarSessionsShowCron],
      ["Show system sessions", loadStoredSidebarSessionsShowSystem],
    ] as const) {
      const before = read();
      await page.getByRole("switch", { name, exact: true }).click();
      expect(read()).toBe(!before);
      await expectFilterCount(1);
    }
    expect(menu.querySelector("#sidebar-sessions-owner")).toBeNull();
    await choose(/^Hide empty groups:/, "Never");
    await role("button", "Reset").click();
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    expect(sidebar.sessionOwnerFilterId).toBeNull();
    expect(loadStoredSidebarSessionsShowCron()).toBe(false);
    expect(loadStoredSidebarSessionsShowSystem()).toBe(false);
    expect(loadStoredSidebarSessionsGrouping()).toBe("category");
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);
    await expect.element(role("button", "Hide empty groups: When filtering")).toBeVisible();
    await expectFilterCount(0);
    await expect.element(role("radio", "Active")).toHaveFocus();
    expect(query(".sidebar-session-sort-menu")).toBe(menu);
    await role("switch", "Show automation sessions").click();
    await expectFilterCount(0, true);
    await role("button", "Reset").click();
    expect(loadStoredSidebarSessionsShowCron()).toBe(false);
    await expectFilterCount(0);
    await choose(/^Hide empty groups:/, "Always");
    expect(query('[data-session-section="category:Empty"]')).toBeNull();
    await choose(/^Hide empty groups:/, "Never");
    expect(query('[data-session-section="category:Empty"]')).not.toBeNull();
  });
});
