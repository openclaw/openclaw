import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("shows the same mixed avatars in count-aware groups without a backing circle", async () => {
    await import("./app-sidebar.ts");
    const { render } = await import("lit");
    const { renderSidebarAgentMenuSwitcher } = await import("./sidebar-agent-menu-switcher.ts");
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
    for (const count of [0, 1, 2, 3, 4, 5, 8]) {
      render(
        renderSidebarAgentMenuSwitcher({
          activeId: agents[0]!.id,
          allAgentsScope: true,
          openMode: "hover",
          agents: agents.slice(0, count),
          identities: new Map(),
          pinnedAgentIds: [],
          resolveAvatarUrl: (url) => url,
          avatarErrorHandler: () => () => {},
          agentUnreadCount: () => 0,
        }),
        root,
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      const all = root.querySelector('[value="scope:all"]');
      if (count < 2) {
        expect(all).toBeNull();
        continue;
      }
      expect(all?.getAttribute("aria-current")).toBe("true");
      expect(all?.querySelector(".agent-select__option-label")?.textContent?.trim()).toBe(
        "Show all",
      );
      const group = all!.querySelector<HTMLElement>(".sidebar-agent-menu__avatar-group")!;
      const items = [...group.querySelectorAll<HTMLElement>(".sidebar-agent-menu__group-item")];
      expect(items).toHaveLength(Math.min(count, 4));
      expect(getComputedStyle(group).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(group.querySelector("img")?.getAttribute("src")).toBe(image);
      expect(group.querySelector('[data-avatar="🧭"]')).not.toBeNull();
      expect(group.querySelector(".sidebar-agent-menu__group-count")?.textContent?.trim()).toBe(
        count > 4 ? String(count - 3) + "+" : undefined,
      );
      const boxes = items.map((item) => item.getBoundingClientRect());
      expect(boxes[0]!.width).toBeGreaterThan(0);
      if (count === 2) {
        expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
        expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);
        expect(boxes[1]!.left).toBeLessThan(boxes[0]!.right);
        expect(boxes[1]!.top).toBeLessThan(boxes[0]!.bottom);
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

  it("centers short and wrapped names under active and inactive avatars", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Molty" },
          { id: "release", name: "Release reviewer" },
          { id: "research", name: "Research planning and documentation assistant" },
          { id: "scout", name: "Scout" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(5);
    await expect.poll(() => document.activeElement).toBe(tiles[1]);
    const { userEvent } = await import("vitest/browser");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tiles[2]);
    await expect
      .poll(() =>
        tiles.map((tile) => tile.classList.contains("sidebar-agent-menu__agent-switch--active")),
      )
      .toEqual([false, true, false, false, false]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = tile.querySelector<HTMLElement>(".sidebar-agent-menu__agent-avatar")!;
      const label = tile.querySelector<HTMLElement>(".agent-select__option-label")!;
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      expect(
        Math.abs(labelBox.x + labelBox.width / 2 - (avatarBox.x + avatarBox.width / 2)),
        label.textContent ?? "agent name",
      ).toBeLessThanOrEqual(1);
    }

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
    await sidebar.updateComplete;
    const all = sidebar.querySelector<HTMLElement>('[value="scope:all"]');
    await expect.poll(() => document.activeElement).toBe(all);
    expect(all?.getAttribute("aria-current")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(sidebar.querySelector('[value="agent:main"]'));
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
      await import("./app-sidebar.ts");
      await import("./sidebar-agent-roster.ts");
      const { createGatewayHarness, createSessions, mountSidebar } =
        await import("../test-helpers/app-sidebar.ts");
      const { sidebar } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "OpenClaw" },
            { id: "research", name: "Research" },
          ],
        },
      );
      await document.fonts.ready;
      const measure = (header: HTMLElement, avatarSelector: string) => {
        const avatar = header.querySelector<HTMLElement>(avatarSelector)!.getBoundingClientRect();
        const name = header
          .querySelector<HTMLElement>(".sidebar-agent-card__name-text")!
          .getBoundingClientRect();
        const chevron = header
          .querySelector<HTMLElement>(".sidebar-agent-card__chevron")!
          .getBoundingClientRect();
        return [
          avatar.width,
          avatar.height,
          name.x - avatar.right,
          chevron.x - name.right,
          name.y + name.height / 2 - (avatar.y + avatar.height / 2),
          chevron.y + chevron.height / 2 - (avatar.y + avatar.height / 2),
        ];
      };
      const agent = measure(
        sidebar.querySelector<HTMLElement>(".sidebar-agent-card__main")!,
        ".sidebar-agent-card__avatar",
      );
      sidebar.sidebarAgentsMode = "roster";
      await sidebar.updateComplete;
      const workspaceHeader = sidebar.querySelector<HTMLElement>(
        ".sidebar-workspace-header__main",
      )!;
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
      expect(
        Math.abs(glyphBox.x + glyphBox.width / 2 - (markBox.x + markBox.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(glyphBox.y + glyphBox.height / 2 - (markBox.y + markBox.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(mark.querySelector("animate, animateTransform")).toBeNull();
      expect(mark.getAnimations({ subtree: true })).toHaveLength(0);
    },
  );
});
