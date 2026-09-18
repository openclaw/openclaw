import { describe, expect, it, onTestFinished, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  setupSidebarTest,
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
import "../test-helpers/load-styles.ts";
import "./app-sidebar.ts";

setupSidebarTest();

async function mountFilters(width: number) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 560);
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  const sessions = createSessionsHarness("main", ["agent:main:ada", "agent:main:bob"]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "profile-ada", label: "Ada" },
    { type: "human", id: "profile-bob", label: "Bob" },
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
      const filters = page.getByRole("menuitem", { name: /^Filters / });
      const view = page.getByRole("menuitem", { name: /^View / });
      const expectFits = async () => {
        const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel")!;
        await expect.element(menu).toBeVisible();
        const bounds = menu.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.height).toBeLessThanOrEqual(innerHeight);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      };
      await trigger.click();
      await expect.element(filters).toHaveFocus();
      await expect.poll(() => occlusion).toEqual([false, true]);
      await expectFits();
      await userEvent.keyboard("{End}");
      await expect
        .element(page.getByRole("menuitem", { name: "Session sources…", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Home}{ArrowDown}");
      await expect.element(view).toHaveFocus();
      await userEvent.keyboard(direction === "rtl" ? "{ArrowLeft}" : "{ArrowRight}");
      await expect
        .element(page.getByRole("menuitem", { name: "Group by: Custom groups", exact: true }))
        .toHaveFocus();
      await expectFits();
      await userEvent.keyboard("{ArrowDown}{Enter}");
      await expect
        .element(page.getByRole("option", { name: "Created", exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(loadStoredSidebarSessionSortMode()).toBe("updated");
      await expect
        .element(page.getByRole("menuitem", { name: "Sort by: Last updated", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(view).toHaveFocus();
      await expect.element(view).toMatchTextContent("Last updated");
      await userEvent.keyboard("{ArrowUp}{Enter}");
      await expect
        .element(page.getByRole("menuitem", { name: "Status: Active", exact: true }))
        .toHaveFocus();
      await expectFits();
      await userEvent.keyboard(direction === "rtl" ? "{ArrowRight}" : "{ArrowLeft}");
      await expect.element(filters).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false]);
      await trigger.click();
      await expect.element(filters).toHaveFocus();
      await expect.poll(() => occlusion).toEqual([false, true, false, true]);
      await trigger.click();
      await expect.element(trigger).toHaveFocus();
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false, true, false]);
    },
  );

  it("routes every control to the existing preferences and keeps choices open", async () => {
    const { sidebar, sessions, page } = await mountFilters(1440);
    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu")!;
    const showPage = async (name: "View" | "Filters") => {
      const back = sidebar.querySelector<HTMLButtonElement>("#sidebar-sessions-back");
      if (back) {
        await page.elementLocator(back).click();
      }
      await page.getByRole("menuitem", { name: new RegExp(`^${name} `) }).click();
    };
    await expect
      .element(page.getByRole("menuitem", { name: /^Filters / }))
      .toMatchTextContent("Active · All owners");
    await expect
      .element(page.getByRole("menuitem", { name: /^View / }))
      .toMatchTextContent("Custom groups · Created · Preview off");
    for (const [subpage, label, choice, expected, read] of [
      ["View", "Group by", "Person", "person", loadStoredSidebarSessionsGrouping],
      ["View", "Sort by", "Owners", "people", loadStoredSidebarSessionSortMode],
      ["Filters", "Status", "All", "all", loadStoredSidebarSessionStatusFilter],
    ] as const) {
      await showPage(subpage);
      await page.getByRole("menuitem", { name: new RegExp(`^${label}:`) }).click();
      await page.getByRole("option", { name: choice, exact: true }).click();
      expect(read()).toBe(expected);
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    }
    for (const [subpage, name, read] of [
      ["View", "Show message preview", loadStoredSidebarSessionsShowPreview],
      ["Filters", "Automation", loadStoredSidebarSessionsShowCron],
      ["Filters", "System", loadStoredSidebarSessionsShowSystem],
    ] as const) {
      await showPage(subpage);
      const before = read();
      await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
      expect(read()).toBe(!before);
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    }
    await page.getByRole("menuitem", { name: "Owners: All owners", exact: true }).click();
    await page.getByRole("option", { name: "Involving me", exact: true }).click();
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ involvingMe: true }));
    await page.getByRole("menuitem", { name: "Owners: Involving me", exact: true }).click();
    await page.getByRole("option", { name: "Specific owner", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Bob", exact: true }).click();
    expect(sidebar.sessionOwnerFilterId).toBe("profile-bob");
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "profile-bob" }));
    expect(sidebar.querySelector(".sidebar-session-owner-picker")).toBeNull();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    await page.getByRole("menuitem", { name: /^Owners:/ }).click();
    await page.getByRole("option", { name: "All owners", exact: true }).click();
    expect(sidebar.sessionOwnerFilterId).toBeNull();
    await showPage("View");
    await page.getByRole("menuitem", { name: /^Group by:/ }).click();
    await page.getByRole("option", { name: "Custom groups", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Hide empty groups: When filtering", exact: true })
      .click();
    await page.getByRole("option", { name: "Always", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).toBeNull();
    await page.getByRole("menuitem", { name: "Hide empty groups: Always", exact: true }).click();
    await page.getByRole("option", { name: "Never", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    await page.getByRole("menuitem", { name: /^Back/ }).click();
    await expect
      .element(page.getByRole("menuitem", { name: /^Filters / }))
      .toMatchTextContent("All · All owners · + Automation · + System");
    await expect
      .element(page.getByRole("menuitem", { name: /^View / }))
      .toMatchTextContent("Custom groups · Owners · Preview on");
  });
});
