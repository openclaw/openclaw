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
import "../styles/settings-controls.css";
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
      const active = page.getByRole("radio", { name: "Active", exact: true });
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
        const rows = [...menu.querySelectorAll<HTMLElement>(".sidebar-session-menu-row")];
        const controls = rows.map((row) => row.lastElementChild!.getBoundingClientRect());
        for (const [index, row] of rows.entries()) {
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
          expect(row.getBoundingClientRect().height).toBe(32);
          expect(controls[index]!.left).toBeCloseTo(controls[0]!.left, 1);
          expect(controls[index]!.right).toBeCloseTo(controls[0]!.right, 1);
        }
      };
      await trigger.click();
      await expect.element(active).toHaveFocus();
      await expect.poll(() => occlusion).toEqual([false, true]);
      await expectFits();
      await userEvent.keyboard("{ArrowRight}");
      await expect
        .element(page.getByRole("radio", { name: "Archived", exact: true }))
        .toHaveFocus();
      expect(loadStoredSidebarSessionStatusFilter()).toBe("archived");
      await userEvent.tab();
      await expect.element(page.getByRole("button", { name: /^Owners:/ })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("listbox", { name: "Owners", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("option", { name: "All owners", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("option", { name: "Involving me", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("option", { name: "Ada (You)", exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("option", { name: "Bob", exact: true })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("button", { name: "Owners: All owners", exact: true }))
        .toHaveFocus();
      await expectFits();
      await userEvent.tab();
      await expect
        .element(page.getByRole("checkbox", { name: "Automation", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("checkbox", { name: "System", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("button", { name: "Group by: Custom groups", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
      await expect.poll(loadStoredSidebarSessionsGrouping).toBe("project");
      await userEvent.tab();
      await expect.element(page.getByRole("radio", { name: "Created", exact: true })).toHaveFocus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.poll(loadStoredSidebarSessionSortMode).toBe("updated");
      await userEvent.tab();
      await expect
        .element(page.getByRole("radio", { name: "When filtering", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("checkbox", { name: "Show message preview", exact: true }))
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("link", { name: "Session sources…", exact: true }))
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
      await trigger.click();
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false, true, false]);
    },
  );

  it("applies every preference instantly and resets only active filters", async () => {
    const { sidebar, sessions, page } = await mountFilters(1440);
    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu")!;
    const expectFilterCount = async (count: number) => {
      await expect
        .poll(
          () => sidebar.querySelector(".sidebar-session-filter-count")?.textContent?.trim() ?? null,
        )
        .toBe(count ? String(count) : null);
      expect(sidebar.querySelector(".sidebar-session-sort")?.getAttribute("aria-description")).toBe(
        count ? `Active filters: ${count}` : null,
      );
      expect(sidebar.querySelector("#sidebar-sessions-reset") !== null).toBe(count > 0);
    };
    await expectFilterCount(0);
    await page.getByRole("button", { name: "Group by: Custom groups", exact: true }).click();
    await page.getByRole("option", { name: "Person", exact: true }).click();
    expect(loadStoredSidebarSessionsGrouping()).toBe("person");
    await expectFilterCount(0);
    for (const [choice, expected, read] of [
      ["Owners", "people", loadStoredSidebarSessionSortMode],
      ["All", "all", loadStoredSidebarSessionStatusFilter],
    ] as const) {
      await page.getByRole("radio", { name: choice, exact: true }).click();
      expect(read()).toBe(expected);
      await expectFilterCount(choice === "All" ? 1 : 0);
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    }
    for (const [name, read] of [
      ["Show message preview", loadStoredSidebarSessionsShowPreview],
      ["Automation", loadStoredSidebarSessionsShowCron],
      ["System", loadStoredSidebarSessionsShowSystem],
    ] as const) {
      const before = read();
      await page.getByRole("checkbox", { name, exact: true }).click();
      expect(read()).toBe(!before);
      await expectFilterCount(name === "Show message preview" ? 1 : name === "Automation" ? 2 : 3);
    }
    const owner = page.getByRole("button", { name: /^Owners:/ });
    await owner.click();
    await page.getByRole("option", { name: "Involving me", exact: true }).click();
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ involvingMe: true }));
    await expectFilterCount(4);
    await owner.click();
    await page.getByRole("option", { name: "Bob", exact: true }).click();
    expect(sidebar.sessionOwnerFilterId).toBe("profile-bob");
    await expectFilterCount(4);
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "profile-bob" }));
    await page.getByRole("radio", { name: "Never", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    expect(sidebar.sessionOwnerFilterId).toBeNull();
    expect(loadStoredSidebarSessionsShowCron()).toBe(false);
    expect(loadStoredSidebarSessionsShowSystem()).toBe(false);
    expect(loadStoredSidebarSessionsGrouping()).toBe("person");
    expect(loadStoredSidebarSessionSortMode()).toBe("people");
    expect(loadStoredSidebarSessionsShowPreview()).toBe(true);
    await expect.element(page.getByRole("radio", { name: "Never", exact: true })).toBeChecked();
    await expectFilterCount(0);
    await expect.element(page.getByRole("radio", { name: "Active", exact: true })).toHaveFocus();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    await page.getByRole("button", { name: "Group by: Person", exact: true }).click();
    await page.getByRole("option", { name: "Custom groups", exact: true }).click();
    await page.getByRole("radio", { name: "Always", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).toBeNull();
    await page.getByRole("radio", { name: "Never", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).not.toBeNull();
  });
});
