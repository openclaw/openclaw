import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import "../pages/chat/components/browser-tab-card.css";
import { BrowserTabCardHost } from "../pages/chat/components/browser-tab-card.tsx";
import {
  makeCapabilities,
  makeMenu,
} from "../pages/chat/components/chat-composer-menu.test-support.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "../pages/chat/components/chat-composer-menu.tsx";
import { ChatComposerPlusMenu } from "../pages/chat/components/chat-composer-plus-menu.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";
import "./agent-select-registration.ts";
import "./menu-surface.ts";
import { Menu, type MenuProps } from "./solid/menu.tsx";
import "./resizable-divider.ts";

// Nav's stacking context is below the resizer. Plain overlays need a top-layer
// surface; owned Menus use their own popover. jsdom cannot prove paint order.
const hasPopoverApi = typeof HTMLElement.prototype.showPopover === "function";
const originalTheme = ["data-theme", "data-theme-mode"].map(
  (name) => [name, document.documentElement.getAttribute(name)] as const,
);

afterEach(async () => {
  cleanupSolid();
  document.body.replaceChildren();
  await Promise.resolve();
  vi.unstubAllGlobals();
  for (const [name, value] of originalTheme) {
    if (value === null) {
      document.documentElement.removeAttribute(name);
    } else {
      document.documentElement.setAttribute(name, value);
    }
  }
});

// The mobile drawer hides the resizer; import lazily for jsdom collection.
async function useDesktopViewport() {
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 800);
}

function mountShell() {
  const shell = document.createElement("div");
  shell.className = "shell";
  // Keep fixed positioning and hit-testing independent of the entry animation.
  shell.style.animation = "none";
  shell.innerHTML = `<div class="shell-nav"></div>
    <resizable-divider class="sidebar-resizer"></resizable-divider><main class="content"></main>`;
  document.body.append(shell);
  return {
    nav: shell.querySelector<HTMLElement>(".shell-nav")!,
    divider: shell.querySelector<HTMLElement>(".sidebar-resizer")!,
  };
}

function createSortMenu() {
  const menu = document.createElement("div");
  menu.className = "sidebar-session-sort-menu";
  menu.innerHTML = '<button type="button" class="sidebar-session-sort-menu__item">Created</button>';
  return menu;
}

/** Places the menu so it straddles the divider, then hit-tests on the divider line. */
function hitTestOnDivider(menu: HTMLElement, divider: HTMLElement): Element | null {
  const dividerBounds = divider.getBoundingClientRect();
  menu.style.left = `${Math.round(dividerBounds.left) - 120}px`;
  menu.style.top = "100px";
  const menuBounds = menu.getBoundingClientRect();
  expect(menuBounds.right).toBeGreaterThan(dividerBounds.left);
  const x = dividerBounds.left + dividerBounds.width / 2;
  const y = menuBounds.top + menuBounds.height / 2;
  return document.elementFromPoint(x, y);
}

function query(root: ParentNode, selector: string) {
  return root.querySelector<HTMLElement>(selector)!;
}

function mountMenu(props: MenuProps, container?: HTMLElement) {
  const mounted = mountSolid(() => <Menu {...props} />, container ? { container } : undefined);
  flush();
  return mounted.container;
}

async function openMenu(host: HTMLElement, selector = ".oc-menu-trigger") {
  const { page } = await import("vitest/browser");
  await page.elementLocator(query(host, selector)).click();
  const menu = query(host, ".oc-menu");
  await expect.poll(() => menu.dataset.phase).toBe("open");
  return menu;
}

function colorSwatch(color: string, parent = document.body) {
  const swatch = parent.appendChild(document.createElement("div"));
  swatch.style.backgroundColor = color;
  return getComputedStyle(swatch).backgroundColor;
}

function animationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe.skipIf(!hasPopoverApi)("sidebar menu stacking", () => {
  it("paints a plain menu hosted in openclaw-menu-surface above the resizer divider", async () => {
    await useDesktopViewport();
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
    const nearby: boolean[] = [];
    const distant: boolean[] = [];
    for (const [events, bounds] of [
      [nearby, new DOMRect(300, 100, 200, 400)],
      [distant, new DOMRect(900, 100, 300, 400)],
    ] as const) {
      onTestFinished(
        subscribeNativeOverlayOcclusion(
          (occluded) => events.push(occluded),
          () => bounds,
        ),
      );
    }
    const { nav, divider } = mountShell();
    const surface = document.createElement("openclaw-menu-surface");
    const menu = createSortMenu();
    nav.append(menu);
    expect(hitTestOnDivider(menu, divider)).toBe(divider);
    surface.append(menu);
    nav.append(surface);

    expect(surface.matches(":popover-open")).toBe(true);
    const hit = hitTestOnDivider(menu, divider);
    expect(hit).not.toBeNull();
    expect(menu.contains(hit)).toBe(true);
    expect(surface.getBoundingClientRect().width).toBe(0);
    menu.style.left = "250px";
    // Occlusion samples geometry on animation frames. Wait for that boundary
    // rather than racing a wall-clock poll against background WebKit frames.
    await animationFrame();
    expect(nearby).toEqual([false, true]);
    expect(distant).toEqual([false]);
    menu.style.left = "850px";
    await animationFrame();
    expect(nearby).toEqual([false, true, false]);
    expect(distant).toEqual([false, true]);
  });

  it("paints a native menu above the divider through its own popover", async () => {
    await useDesktopViewport();
    const { nav, divider } = mountShell();
    const dividerBounds = divider.getBoundingClientRect();
    mountMenu(
      {
        id: "sort-menu-stacking",
        label: "Sort sessions",
        panelClass: "sidebar-session-sort-menu",
        triggerAttributes: {
          style: {
            position: "fixed",
            left: `${Math.round(dividerBounds.left) - 120}px`,
            top: "100px",
          },
        },
        items: [{ id: "created", label: "Created", class: "sidebar-session-sort-menu__item" }],
      },
      nav,
    );
    // Popover membership precedes positioning; hit-test only after the completed show.
    const menu = await openMenu(nav);
    expect(menu.matches(":popover-open")).toBe(true);
    expect(menu.closest("openclaw-menu-surface")).toBeNull();
    const menuBounds = menu.getBoundingClientRect();
    expect(menuBounds.right).toBeGreaterThan(dividerBounds.left);
    const hit = document.elementFromPoint(
      dividerBounds.left + dividerBounds.width / 2,
      menuBounds.top + menuBounds.height / 2,
    );
    expect(hit).not.toBeNull();
    expect(menu.contains(hit)).toBe(true);
  });
});

describe.skipIf(!hasPopoverApi)("agent picker surface", () => {
  it("stays opaque while the menu animates open", async () => {
    await useDesktopViewport();
    const picker = document.createElement("openclaw-agent-select");
    picker.options = [{ value: "all", label: "All agents" }];
    document.body.append(picker);
    await picker.updateComplete;
    const menu = picker.querySelector<HTMLElement>(".agent-select__menu")!;
    menu.style.setProperty("--oc-overlay-show-duration", "1s");
    picker.querySelector<HTMLButtonElement>(".agent-select__trigger")!.click();
    await expect.poll(() => menu.getAnimations().length).toBeGreaterThan(0);
    for (const animation of menu.getAnimations()) {
      animation.pause();
      animation.currentTime = 500;
    }
    expect(getComputedStyle(menu).opacity).toBe("1");
    expect(getComputedStyle(menu).scale).not.toBe("1");
  });
});

describe.skipIf(!hasPopoverApi)("submenu parent highlight", () => {
  it.each([
    ["", "keyboard"],
    ["", "pointer"],
    ["session-menu__item", "keyboard"],
    ["session-menu__item", "pointer"],
    ["sidebar-customize-menu__item", "keyboard"],
    ["sidebar-customize-menu__item", "pointer"],
  ])("keeps %s highlighted during %s submenu navigation", async (className, input) => {
    await useDesktopViewport();
    const { page, userEvent } = await import("vitest/browser");
    const container = mountMenu({
      id: "submenu-highlight",
      label: "Actions",
      items: [
        {
          id: "parent",
          label: "Parent",
          class: className,
          children: [{ id: "child", label: "Child", class: className }],
        },
        { id: "sibling", label: "Other action", class: className },
      ],
    });
    const parent = query(container, '[data-value="parent"]');
    const child = query(container, '[data-value="child"]');
    const sibling = query(container, '[data-value="sibling"]');
    const highlight = colorSwatch("var(--bg-hover)");

    await openMenu(container);
    await expect.poll(() => document.activeElement).toBe(parent);
    if (input === "keyboard") {
      await userEvent.keyboard("{ArrowRight}");
      await expect.poll(() => document.activeElement).toBe(child);
    } else {
      await page.elementLocator(parent).hover();
      await page.elementLocator(child).hover();
      await expect.poll(() => child.hasAttribute("data-highlighted")).toBe(true);
      expect(document.activeElement).toBe(parent);
    }
    await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("true");
    // A loaded WebKit worker can sample the color transition just before the poll expires.
    await Promise.all(parent.getAnimations().map((animation) => animation.finished));
    expect(getComputedStyle(parent).backgroundColor).toBe(highlight);

    if (input === "pointer") {
      // Hover preserves keyboard focus; ArrowRight transfers it into the submenu.
      await userEvent.keyboard("{ArrowRight}");
      await expect.poll(() => document.activeElement).toBe(child);
    }
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => document.activeElement).toBe(parent);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(sibling);
    await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("false");
    // Hover highlights independently of submenu expansion and keyboard focus.
    await page.elementLocator(sibling).hover();
    await expect.poll(() => parent.matches(":hover")).toBe(false);
    await expect.poll(() => getComputedStyle(parent).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
});

describe.skipIf(!hasPopoverApi)("action menu typography", () => {
  it.each([390, 1440])(
    "keeps plain and session actions at the same text scale at %ipx",
    async (width) => {
      const { page } = await import("vitest/browser");
      await page.viewport(width, 900);
      const host = document.createElement("div");
      host.style.fontSize = "20px";
      host.style.setProperty("--control-ui-text-scale", "1");
      document.body.append(host);
      mountSolid(
        () => (
          <>
            <Menu
              id="plain-action-typography"
              label="Workspace actions"
              items={[{ id: "copy-path", label: "Copy path" }]}
            />
            <Menu
              id="session-action-typography"
              label="Session actions"
              class="session-menu"
              items={[{ id: "copy-session", label: "Copy session", class: "session-menu__item" }]}
            />
          </>
        ),
        { container: host },
      );
      flush();
      const plain = query(host, '[data-value="copy-path"]');
      const session = query(host, '[data-value="copy-session"]');
      await openMenu(host);

      for (const scale of [1, 1.4]) {
        host.style.setProperty("--control-ui-text-scale", String(scale));
        const size = (item: HTMLElement) => Number.parseFloat(getComputedStyle(item).fontSize);
        expect(size(plain)).toBeCloseTo(13 * scale, 1);
        expect(size(plain)).toBeCloseTo(size(session), 1);
      }
    },
  );
});

describe.skipIf(!hasPopoverApi)("platform menu hover", () => {
  async function hoverBackground(element: HTMLElement, expected: string) {
    const { page } = await import("vitest/browser");
    await page.elementLocator(element).hover();
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    await expect.poll(() => getComputedStyle(element).backgroundColor).toBe(expected);
  }

  describe.each(["dark", "light"] as const)("%s mode", (theme) => {
    let host: HTMLElement;
    let highlight: string;
    beforeEach(async () => {
      await useDesktopViewport();
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themeMode = theme;
      highlight = colorSwatch("var(--bg-hover)");
      host = document.body.appendChild(document.createElement("div"));
    });

    it("matches attachment and capability actions", async () => {
      host.style.padding = "400px 40px 0";
      mountSolid(
        () => (
          <ChatComposerPlusMenu
            menu={makeMenu({ capabilityMenu: makeCapabilities({ basePath: "" }) })}
          />
        ),
        { container: host },
      );
      await openMenu(host, '[aria-haspopup="menu"]');
      await expect.poll(() => host.querySelector('[data-value="media"]')).not.toBeNull();
      const media = query(host, '[data-value="media"]');
      const skills = query(host, '[data-value="open-skills"]');
      await hoverBackground(media, highlight);
      const attachmentHover = getComputedStyle(media).backgroundColor;
      await hoverBackground(skills, attachmentHover);
    });

    it("matches session menu geometry and theme inside browser cards", async () => {
      const view = mountSolid(() => (
        <BrowserTabCardHost
          preview={{
            kind: "browser-tab",
            target: "host",
            profile: "managed",
            targetId: "tab-1",
            url: "https://example.test/page",
            title: "Example page",
          }}
        />
      ));
      flush();
      const card = query(view.container, "openclaw-browser-tab-card");
      const menu = await openMenu(card, ".more");
      const item = query(card, '[value="copy-url"]');
      mountMenu(
        {
          id: "browser-card-reference",
          label: "Reference menu",
          class: "session-menu",
          items: [{ id: "reference", label: "Reference action", class: "session-menu__item" }],
        },
        host,
      );
      const referenceMenu = query(host, ".oc-menu");
      const referenceItem = query(host, '[data-value="reference"]');
      for (const property of ["background-color", "border-radius", "padding", "box-shadow"]) {
        expect(getComputedStyle(menu).getPropertyValue(property)).toBe(
          getComputedStyle(referenceMenu).getPropertyValue(property),
        );
      }
      for (const property of ["min-height", "padding", "font-size", "color"]) {
        expect(getComputedStyle(item).getPropertyValue(property)).toBe(
          getComputedStyle(referenceItem).getPropertyValue(property),
        );
      }
      await hoverBackground(item, highlight);
    });

    it("uses platform hover for slash suggestions", async () => {
      mountSolid(
        () => {
          const [active, setActive] = createSignal(false);
          return (
            <ComposerMenuOption
              id="hover-command"
              active={active()}
              select={() => {}}
              hover={() => setActive(true)}
              icon=""
              name="/help"
              description="Show commands"
            />
          );
        },
        { container: host },
      );
      const option = query(host, '[role="option"]');
      await hoverBackground(option, highlight);
      expect(option.getAttribute("aria-selected")).toBe("true");
      expect(getComputedStyle(option).cursor).toBe("pointer");
    });

    it("preserves disabled and danger states while neutral focus matches hover", async () => {
      mountMenu(
        {
          id: "menu-states",
          label: "Actions",
          items: [
            { id: "neutral", label: "Open" },
            { id: "disabled", label: "Unavailable", disabled: true },
            { id: "danger", label: "Delete", variant: "danger" },
          ],
        },
        host,
      );
      const { userEvent } = await import("vitest/browser");
      const neutral = query(host, '[data-value="neutral"]');
      const disabled = query(host, '[data-value="disabled"]');
      const danger = query(host, '[data-value="danger"]');
      await openMenu(host);
      await userEvent.keyboard("{ArrowDown}");
      await userEvent.keyboard("{Home}");
      await expect.poll(() => document.activeElement).toBe(neutral);
      await expect.poll(() => getComputedStyle(neutral).backgroundColor).toBe(highlight);
      await hoverBackground(neutral, highlight);
      await hoverBackground(disabled, "rgba(0, 0, 0, 0)");
      const dangerHighlight = colorSwatch("var(--danger-subtle)", danger);
      expect(dangerHighlight).not.toBe(highlight);
      await hoverBackground(danger, dangerHighlight);
    });
  });
});
