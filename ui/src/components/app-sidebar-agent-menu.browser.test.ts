import { flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewayAgentRow } from "../api/types.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

const query = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector)!;
const center = (box: DOMRect, axis: "x" | "y") =>
  box[axis] + (axis === "x" ? box.width : box.height) / 2;

async function mountAgents(client: GatewayBrowserClient, agents: GatewayAgentRow[]) {
  await import("./app-sidebar.tsx");
  const { createGatewayHarness, createSessions, mountSidebar } =
    await import("../test-helpers/app-sidebar.ts");
  return mountSidebar(
    createGatewayHarness(client).gateway,
    createSessions("main", ["agent:main:main"]),
    "panel",
    { defaultId: "main", mainKey: "main", scope: "per-sender", agents },
  );
}

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("shows the same mixed avatars in count-aware groups without a backing circle", async () => {
    await import("./app-sidebar.tsx");
    const { renderSidebarAgentMenuSwitcher } = await import("./sidebar-agent-menu-switcher.tsx");
    const { createMenuControls, Menu } = await import("./solid/menu.tsx");
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=";
    const agents = Array.from({ length: 8 }, (_, index) => ({
      id: "agent-" + index,
      name: "Agent " + index,
      identity: {
        avatarUrl: index === 0 ? image : undefined,
        emoji: index === 1 ? "🧭" : undefined,
      },
    }));
    const root = document.createElement("div");
    root.className = "sidebar-agent-menu";
    root.style.width = "320px";
    document.body.append(root);
    let unmount: (() => void) | undefined;
    for (const count of [0, 1, 2, 3, 4, 5, 8]) {
      unmount?.();
      unmount = mountSolid(
        () => {
          const controls = createMenuControls();
          return Menu({
            id: `agent-menu-${count}`,
            label: "Agents",
            open: true,
            controls,
            items: renderSidebarAgentMenuSwitcher(
              {
                activeId: agents[0]!.id,
                allAgentsScope: true,
                openMode: "hover",
                agents: agents.slice(0, count),
                identities: new Map(),
                resolveAvatarUrl: (url) => url,
                avatarErrorHandler: () => () => {},
                agentUnreadCount: () => 0,
                onAgentSettings: () => {},
              },
              controls,
            ),
          });
        },
        { container: root },
      ).unmount;
      flush();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(root.querySelectorAll(".sidebar-agent-menu__pin")).toHaveLength(0);
      const all = root.querySelector('[data-value="scope:all"]');
      if (count < 2) {
        expect(all).toBeNull();
        continue;
      }
      expect(all?.getAttribute("aria-current")).toBe("true");
      expect(query(all!, ".agent-select__option-label")?.textContent?.trim()).toBe("Show all");
      const group = query(all!, ".sidebar-agent-menu__avatar-group");
      const items = [...group.querySelectorAll<HTMLElement>(".sidebar-agent-menu__group-item")];
      expect(items).toHaveLength(Math.min(count, 4));
      expect(getComputedStyle(group).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(group.querySelector("img")?.getAttribute("src")).toBe(image);
      expect(group.querySelector('[data-avatar="🧭"]')).not.toBeNull();
      expect(query(group, ".sidebar-agent-menu__group-count")?.textContent?.trim()).toBe(
        count > 4 ? String(count - 3) + "+" : undefined,
      );
      const boxes = items.map((item) => item.getBoundingClientRect());
      expect(boxes[0]!.width).toBeGreaterThan(0);
      if (count === 2) {
        expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
        expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);
        expect(boxes[1]!.left).toBeLessThan(boxes[0]!.right);
        expect(boxes[1]!.top).toBeLessThan(boxes[0]!.bottom);
      } else if (count === 3) {
        expect(boxes[0]!.top).toBeGreaterThan(boxes[1]!.top);
        expect(boxes[1]!.top).toBe(boxes[2]!.top);
        expect(boxes[1]!.right).toBeGreaterThan(boxes[2]!.left);
        expect(boxes[0]!.left).toBeGreaterThan(boxes[1]!.left);
        expect(items.map((item) => getComputedStyle(item).zIndex)).toEqual(["3", "1", "2"]);
        const frame = group.getBoundingClientRect();
        for (const [index, box] of boxes.entries()) {
          expect(getComputedStyle(items[index]!).borderTopWidth).toBe("2px");
          const distance = Math.hypot(
            center(box, "x") - center(frame, "x"),
            center(box, "y") - center(frame, "y"),
          );
          expect(distance + box.width / 2).toBeLessThan(frame.width / 2 + 2);
        }
      } else {
        expect(boxes[1]!.top).toBe(boxes[0]!.top);
        expect(boxes[2]!.left).toBe(boxes[0]!.left);
        expect(boxes[2]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
        if (count >= 4) {
          expect(boxes[3]!.left).toBe(boxes[1]!.left);
          expect(boxes[3]!.top).toBe(boxes[2]!.top);
        }
      }
    }
  });

  it("aligns short and wrapped names beside active and inactive avatars", async () => {
    const { sidebar, context } = await mountAgents(
      { instanceId: "self-instance" } as GatewayBrowserClient,
      [
        { id: "main", name: "Molty" },
        { id: "release", name: "Release reviewer" },
        { id: "research", name: "Research planning and documentation assistant" },
        { id: "scout", name: "Scout" },
      ],
    );
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.connected = true;
    await sidebar.updateComplete;
    // Focus is ready before the dropdown's opening animation finishes.
    const menuShown = new Promise<void>((resolve) => {
      const onShown = (event: Event) => {
        if (event.target !== sidebar.querySelector(".sidebar-agent-menu")) {
          return;
        }
        sidebar.removeEventListener("overlay-after-show", onShown, true);
        resolve();
      };
      sidebar.addEventListener("overlay-after-show", onShown, true);
      onTestFinished(() => sidebar.removeEventListener("overlay-after-show", onShown, true));
    });
    query(sidebar, ".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    await menuShown;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    expect(
      [...menu!.querySelectorAll<HTMLElement>("[data-value]")]
        .slice(0, 2)
        .map((item) => item.getAttribute("data-value")),
    ).toEqual(["command:new-agent", "scope:all"]);
    expect(menu!.querySelector("[role=separator]")).toBeNull();
    expect(menu!.querySelector("input")).toBeNull();
    expect(menu!.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    expect(menu!.querySelector('[data-value="command:agents-directory"]')).toBeNull();
    expect(menu!.querySelector('[data-value="command:capabilities"]')).toBeNull();
    expect(menu!.querySelector('[data-value="command:agent-settings"]')).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-agent-card__main")?.closest("openclaw-tooltip"),
    ).toBeNull();

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(5);
    await expect.poll(() => document.activeElement).toBe(tiles[1]);
    const { page, userEvent } = await import("vitest/browser");
    const activeSettings = query(tiles[1]!, ".sidebar-agent-menu__settings");
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    expect(getComputedStyle(activeSettings).opacity).toBe("0");
    await userEvent.hover(tiles[1]!);
    expect(getComputedStyle(activeSettings).opacity).toBe("1");
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    expect(getComputedStyle(activeSettings).opacity).toBe("0");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tiles[2]);
    await userEvent.tab();
    const settings = query(tiles[2]!, ".sidebar-agent-menu__settings") as HTMLButtonElement;
    expect(document.activeElement).toBe(settings);
    expect(settings.hasAttribute("title")).toBe(false);
    expect(getComputedStyle(settings).opacity).toBe("1");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tiles[3]);
    expect(getComputedStyle(settings).opacity).toBe("0");
    await expect
      .poll(() =>
        tiles.map((tile) => tile.classList.contains("sidebar-agent-menu__agent-switch--active")),
      )
      .toEqual([false, true, false, false, false]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = query(tile, ".sidebar-agent-menu__agent-avatar");
      const label = query(tile, ".agent-select__option-label");
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const rowBox = tile.getBoundingClientRect();
      expect(rowBox.height).toBeGreaterThanOrEqual(44);
      expect(avatarBox.width).toBe(28);
      expect(labelBox.left - avatarBox.right).toBe(10);
      expect(Math.abs(center(avatarBox, "y") - center(rowBox, "y"))).toBeLessThanOrEqual(1);
    }

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    query(sidebar, ".sidebar-workspace-header__main")?.click();
    await sidebar.updateComplete;
    const all = sidebar.querySelector<HTMLElement>('[data-value="scope:all"]');
    await expect.poll(() => document.activeElement).toBe(all);
    expect(all?.getAttribute("aria-current")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .poll(() => document.activeElement)
      .toBe(sidebar.querySelector('[data-value="agent:main"]'));
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .poll(() => document.activeElement)
      .toBe(sidebar.querySelector('[data-value="agent:release"]'));
    await userEvent.tab();
    const releaseSettings = sidebar.querySelector<HTMLButtonElement>(
      '[data-value="agent:release"] .sidebar-agent-menu__settings',
    );
    expect(document.activeElement).toBe(releaseSettings);
    await userEvent.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("agents", {
      pathname: "/settings/agents/release",
    });
    expect(context.agentSelection.state.selectedId).toBe("main");
  });

  it.each([
    { theme: "light", width: 1440 },
    { theme: "dark", width: 1440 },
    { theme: "light", width: 390 },
    { theme: "dark", width: 390 },
  ])(
    "matches identity header geometry with an inset static workspace mark ($theme, $width px)",
    async ({ theme, width }) => {
      const { page } = await import("vitest/browser");
      const originalTheme = document.documentElement.getAttribute("data-theme-mode");
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      onTestFinished(async () => {
        if (originalTheme === null) {
          document.documentElement.removeAttribute("data-theme-mode");
        } else {
          document.documentElement.setAttribute("data-theme-mode", originalTheme);
        }
        await page.viewport(viewport.width, viewport.height);
      });
      document.documentElement.setAttribute("data-theme-mode", theme);
      await page.viewport(width, 900);
      await import("./app-sidebar.tsx");
      await import("./sidebar-agent-roster.tsx");
      const { sidebar } = await mountAgents({} as GatewayBrowserClient, [
        { id: "main", name: "OpenClaw" },
        { id: "research", name: "Research" },
      ]);
      await document.fonts.ready;
      const measure = (header: HTMLElement, avatarSelector: string) => {
        const avatar = query(header, avatarSelector).getBoundingClientRect();
        const name = query(header, ".sidebar-agent-card__name-text").getBoundingClientRect();
        const chevron = query(header, ".sidebar-agent-card__chevron").getBoundingClientRect();
        return [
          avatar.width,
          avatar.height,
          name.x - avatar.right,
          chevron.x - name.right,
          center(name, "y") - center(avatar, "y"),
          center(chevron, "y") - center(avatar, "y"),
        ];
      };
      const agent = measure(
        query(sidebar, ".sidebar-agent-card__main"),
        ".sidebar-agent-card__avatar",
      );
      sidebar.sidebarAgentsMode = "roster";
      await sidebar.updateComplete;
      const workspaceHeader = query(sidebar, ".sidebar-workspace-header__main");
      const workspace = measure(workspaceHeader, ".sidebar-workspace-header__mark");
      for (const [index, dimension] of agent.entries()) {
        expect(Math.abs(workspace[index]! - dimension)).toBeLessThanOrEqual(1);
      }
      const mark = workspaceHeader.querySelector(".sidebar-workspace-header__mark")!;
      const markBox = mark.getBoundingClientRect();
      const glyphBox = mark.querySelector("svg")!.getBoundingClientRect();
      expect(glyphBox.width).toBeGreaterThan(0);
      expect(glyphBox.width).toBeLessThan(markBox.width);
      expect(glyphBox.height).toBeLessThan(markBox.height);
      expect(glyphBox.width).toBe(glyphBox.height);
      expect(Math.abs(center(glyphBox, "x") - center(markBox, "x"))).toBeLessThanOrEqual(1);
      expect(Math.abs(center(glyphBox, "y") - center(markBox, "y"))).toBeLessThanOrEqual(1);
      expect(mark.querySelector("animate, animateTransform")).toBeNull();
      expect(mark.getAnimations({ subtree: true })).toHaveLength(0);
    },
  );
});
