import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import "../pages/chat/components/browser-tab-card.css";
import { BrowserTabCardHost } from "../pages/chat/components/browser-tab-card.tsx";
import { renderComposerMenuOption as ComposerMenuOption } from "../pages/chat/components/chat-composer-menu.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { Menu, type MenuProps } from "./solid/menu.tsx";
import "../test-helpers/load-styles.ts";
import "./agent-select-registration.ts";
import "./menu-surface.ts";
import sessionMenuStyles from "../styles/session-menu.css?inline";
import overlayStyles from "./solid/overlay.css?inline";
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
  const menu = query(host, ".oc-menu");
  const shown = new Promise<void>((resolve) => {
    menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
  await page.elementLocator(query(host, selector)).click();
  await shown;
  expect(menu.dataset.phase).toBe("open");
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
    const submenu = child.closest<HTMLElement>(".oc-menu")!;
    const submenuShown = new Promise<void>((resolve) => {
      submenu.addEventListener("overlay-after-show", () => resolve(), { once: true });
    });
    const highlight = colorSwatch("var(--surface-hover)");

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
    // Keyboard focus can precede submenu presentation and its final highlight transition.
    await submenuShown;
    expect(submenu.dataset.phase).toBe("open");
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
      highlight = colorSwatch("var(--surface-hover)");
      host = document.body.appendChild(document.createElement("div"));
    });

    it.each(["session-first", "overlay-first"])(
      "keeps canonical and plain row states independent with %s styles",
      async (order) => {
        // This matrix checks final colors; animation behavior has its own cases.
        host.style.setProperty("--control-ui-transition-fast", "0s");
        const { page, userEvent } = await import("vitest/browser");
        const style = document.head.appendChild(document.createElement("style"));
        onTestFinished(() => style.remove());
        style.textContent =
          order === "session-first"
            ? `${sessionMenuStyles}\n${overlayStyles}`
            : `${overlayStyles}\n${sessionMenuStyles}`;
        const park = host.appendChild(document.createElement("button"));
        park.textContent = "Outside the menu";
        park.style.cssText = "position: fixed; right: 16px; bottom: 16px";
        const transparent = "rgba(0, 0, 0, 0)";
        const color = (token: string) =>
          token === "transparent" ? transparent : colorSwatch(`var(${token})`);

        // Exercise the state owner with real CSS and browser input. The component
        // scenarios below separately prove Menu and BrowserTabCard composition.
        const states = [
          {
            name: "neutral",
            menu: ["transparent", "--surface-hover", "1"],
            plain: ["transparent", "--bg-hover", "1"],
          },
          {
            name: "expanded",
            menu: ["--surface-hover", "--surface-hover", "1"],
            plain: ["--bg-hover", "--bg-hover", "1"],
          },
          {
            name: "unchecked",
            menu: ["transparent", "--menu-hover", "1"],
            plain: ["transparent", "--bg-hover", "1"],
          },
          {
            name: "checked",
            menu: ["--surface-selected", "--surface-selected-hover", "1"],
            plain: ["transparent", "--bg-hover", "1"],
          },
          {
            name: "danger",
            menu: ["transparent", "--danger-subtle", "1"],
            plain: ["transparent", "--bg-hover", "1"],
          },
          {
            name: "danger-expanded",
            menu: ["--danger-subtle", "--danger-subtle", "1"],
            plain: ["--bg-hover", "--bg-hover", "1"],
          },
          {
            name: "disabled",
            menu: ["transparent", "transparent", "0.5"],
            plain: ["transparent", "transparent", "0.5"],
          },
          {
            name: "aria-disabled",
            menu: ["transparent", "transparent", "0.5"],
            plain: ["transparent", "transparent", "0.5"],
          },
          {
            name: "disabled-expanded",
            menu: ["transparent", "transparent", "0.5"],
            plain: ["--bg-hover", "--bg-hover", "0.5"],
          },
          {
            name: "aria-disabled-expanded",
            menu: ["transparent", "transparent", "0.5"],
            plain: ["--bg-hover", "--bg-hover", "0.5"],
          },
        ] as const;
        for (const className of [
          "oc-menu-item session-menu__item",
          "oc-menu-item sidebar-session-sort-menu__item",
          "session-menu__item",
        ]) {
          const canonical = className.includes("oc-menu-item");
          for (const { name: state, menu, plain } of states) {
            await page.elementLocator(park).hover();
            park.focus();
            const item = host.appendChild(document.createElement("button"));
            item.className = className;
            item.textContent = `${canonical ? "Menu" : "Plain row"}: ${state}`;
            const disabled = state.includes("disabled");
            const expanded = state.includes("expanded");
            const danger = state.includes("danger");
            item.disabled = disabled && !state.startsWith("aria-");
            for (const [attribute, enabled] of [
              ["aria-expanded", expanded],
              ["aria-checked", state === "checked"],
              ["aria-disabled", state.startsWith("aria-")],
            ] as const) {
              if (enabled) {
                item.setAttribute(attribute, "true");
              }
            }
            if (state === "unchecked") {
              item.setAttribute("aria-checked", "false");
            }
            if (danger) {
              item.dataset.variant = "danger";
              item.classList.add("session-menu__item--destructive");
              expect(getComputedStyle(item).color).toBe(color("--danger"));
            }
            const [resting, interactive, opacity] = canonical ? menu : plain;
            const label = `${className}: ${state}`;
            expect(getComputedStyle(item).backgroundColor, `${label} resting`).toBe(color(resting));
            expect(getComputedStyle(item).opacity, `${label} opacity`).toBe(opacity);
            await page.elementLocator(item).hover();
            await expect
              .poll(() => getComputedStyle(item).backgroundColor, {
                message: `${label} hover`,
              })
              .toBe(color(interactive));
            if (!item.disabled) {
              await page.elementLocator(park).hover();
              await userEvent.keyboard("{Tab}");
              item.focus();
              expect(item.matches(":focus-visible"), `${label} keyboard focus`).toBe(true);
              // Plain rows retain their existing focus contract, including aria-disabled rows.
              await expect
                .poll(() => getComputedStyle(item).backgroundColor, {
                  message: `${label} focus`,
                })
                .toBe(color(canonical ? interactive : "--bg-hover"));
            }
            item.remove();
          }
        }
      },
    );

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
      // Hold the entry presentation like a stalled WebKit timeline on a loaded runner:
      // the geometry, theme, and hover checks must not wait for it to settle.
      card.style.setProperty("--oc-overlay-show-duration", "3600s");
      const menu = await openAdmittedMenu(card, ".more");
      const entry = menu.getAnimations();
      expect(entry.length).toBeGreaterThan(0);
      entry.forEach((animation) => animation.pause());
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
      await hoverBackground(item, colorSwatch("var(--surface-hover)"));
      entry.forEach((animation) => animation.finish());
      await expect.poll(() => menu.dataset.phase).toBe("open");
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
      const menuHighlight = colorSwatch("var(--surface-hover)");
      await openMenu(host);
      await userEvent.keyboard("{ArrowDown}");
      await userEvent.keyboard("{Home}");
      await expect.poll(() => document.activeElement).toBe(neutral);
      await expect.poll(() => getComputedStyle(neutral).backgroundColor).toBe(menuHighlight);
      await hoverBackground(neutral, menuHighlight);
      await hoverBackground(disabled, "rgba(0, 0, 0, 0)");
      const dangerHighlight = colorSwatch("var(--danger-subtle)", danger);
      expect(dangerHighlight).not.toBe(menuHighlight);
      await hoverBackground(danger, dangerHighlight);
    });
  });
});

/** Wait for open authority without waiting for the deliberately held entry animation. */
async function openAdmittedMenu(host: HTMLElement, selector: string) {
  const { page } = await import("vitest/browser");
  const trigger = query(host, selector);
  await page.elementLocator(trigger).click();
  const menu = query(host, ".oc-menu");
  await expect
    .poll(() => ({
      expanded: trigger.getAttribute("aria-expanded"),
      shown: menu.matches(":popover-open"),
      interactive: !menu.inert && ["opening", "open"].includes(menu.dataset.phase ?? ""),
    }))
    .toEqual({ expanded: "true", shown: true, interactive: true });
  return menu;
}
