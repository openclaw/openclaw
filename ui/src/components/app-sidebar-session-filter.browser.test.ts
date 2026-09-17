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
  it.each([1440, 390])(
    "keeps keyboard choices, focus and surface inside the viewport at %i px",
    async (width) => {
      vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const { sidebar, page } = await mountFilters(width);
      const occlusion: boolean[] = [];
      onTestFinished(
        subscribeNativeOverlayOcclusion(
          (value) => occlusion.push(value),
          () => new DOMRect(0, 0, innerWidth, innerHeight),
        ),
      );
      const { userEvent } = await import("vitest/browser");
      const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
      await trigger.click();
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-filter-panel")!;
      await expect.element(menu).toBeVisible();
      const group = page.getByRole("group", { name: "Group by", exact: true });
      const custom = group.getByRole("button", { name: "Custom groups", exact: true });
      await expect.element(custom).toHaveFocus();
      await expect.poll(() => occlusion).toEqual([false, true]);
      await userEvent.keyboard("{ArrowRight}");
      const project = group.getByRole("button", { name: "Project", exact: true });
      await expect.element(project).toHaveFocus();
      await expect.element(project).toHaveAttribute("aria-pressed", "true");
      expect(loadStoredSidebarSessionsGrouping()).toBe("project");
      await userEvent.keyboard("{End}");
      await expect.element(group.getByRole("button", { name: "None", exact: true })).toHaveFocus();
      expect(loadStoredSidebarSessionsGrouping()).toBe("none");
      await userEvent.keyboard("{Home}");
      await expect.element(custom).toHaveFocus();
      await userEvent.tab();
      await expect
        .element(
          page
            .getByRole("group", { name: "Sort by", exact: true })
            .getByRole("button", { name: "Created", exact: true }),
        )
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(
          page
            .getByRole("group", { name: "Status", exact: true })
            .getByRole("button", { name: "Active", exact: true }),
        )
        .toHaveFocus();
      await userEvent.tab();
      await expect
        .element(page.getByRole("button", { name: "Owners: All owners", exact: true }))
        .toHaveFocus();
      for (const name of [
        "Show message preview",
        "Show automation sessions",
        "Show system sessions",
      ]) {
        await userEvent.tab();
        await expect.element(page.getByRole("switch", { name, exact: true })).toHaveFocus();
      }
      await userEvent.tab();
      await expect
        .element(
          page.getByRole("button", { name: "Hide empty groups: When filtering", exact: true }),
        )
        .toHaveFocus();
      const bounds = menu.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.height).toBeLessThanOrEqual(innerHeight);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
      await expect.poll(() => occlusion).toEqual([false, true, false]);
      await trigger.click();
      await expect.element(custom).toHaveFocus();
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
    for (const [group, label, expected, read] of [
      ["Group by", "Person", "person", loadStoredSidebarSessionsGrouping],
      ["Sort by", "Owners", "people", loadStoredSidebarSessionSortMode],
      ["Status", "All", "all", loadStoredSidebarSessionStatusFilter],
    ] as const) {
      await page
        .getByRole("group", { name: group, exact: true })
        .getByRole("button", { name: label, exact: true })
        .click();
      expect(read()).toBe(expected);
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
      expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    }
    await page.getByRole("button", { name: "Owners: All owners", exact: true }).click();
    await page.getByRole("option", { name: "Involving me", exact: true }).click();
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ involvingMe: true }));
    await page.getByRole("button", { name: "Owners: Involving me", exact: true }).click();
    await page.getByRole("option", { name: "Specific owner", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Bob", exact: true }).click();
    expect(sidebar.sessionOwnerFilterId).toBe("profile-bob");
    expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "profile-bob" }));
    expect(sidebar.querySelector(".sidebar-session-owner-picker")).toBeNull();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
    await page.getByRole("button", { name: /^Owners:/ }).click();
    await page.getByRole("option", { name: "All owners", exact: true }).click();
    expect(sidebar.sessionOwnerFilterId).toBeNull();
    await page
      .getByRole("group", { name: "Group by", exact: true })
      .getByRole("button", { name: "Custom groups", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Hide empty groups: When filtering", exact: true })
      .click();
    await page.getByRole("option", { name: "Always", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).toBeNull();
    await page.getByRole("button", { name: "Hide empty groups: Always", exact: true }).click();
    await page.getByRole("option", { name: "Never", exact: true }).click();
    expect(sidebar.querySelector('[data-session-section="category:Empty"]')).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(menu);
  });
});
