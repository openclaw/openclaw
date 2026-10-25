import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { emulateOverlayMedia } from "../../test-helpers/overlay-browser-media.ts";
import {
  item,
  mountMenu,
  openMenu,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.tsx";
import { Menu, type MenuItem } from "./menu.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";
import "../../styles/base.css";
import "../../../public/themes/absolutely.css";
import "../../../public/themes/phosphor.css";

const root = document.documentElement;
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");
const originalStyle = root.style.cssText;
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

afterEach(async () => {
  cleanup();
  root.style.cssText = originalStyle;
  for (const [name, value] of [
    ["data-theme", originalTheme],
    ["data-theme-mode", originalMode],
  ] as const) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
  await emulateOverlayMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  await page.viewport(originalWidth, originalHeight);
});

function color(value: string) {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

function expectWithinViewport(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
  return box;
}

function mountModalMenu() {
  let modal!: OpenClawModalDialog;
  render(() => (
    <ModalDialog label="Modal menu" ref={(value) => (modal = value)}>
      <Menu
        id="modal-menu"
        label="Modal actions"
        items={[{ id: "nested", label: "Nested", children: [{ id: "apply", label: "Apply" }] }]}
      />
    </ModalDialog>
  ));
  flush();
  return modal;
}

function details(label: string) {
  return item(label).querySelector(".oc-menu-item__details")!;
}

function entries(prefix: string, count: number, padded = false): MenuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    label: `${prefix} ${padded ? String(index + 1).padStart(2, "0") : index + 1}`,
  }));
}

function positionTrigger(style: Partial<CSSStyleDeclaration>) {
  Object.assign(trigger().style, { position: "fixed" }, style);
}

function expectItemVisible(element: HTMLElement, menu: HTMLElement) {
  const box = expectWithinViewport(menu);
  const itemBox = element.getBoundingClientRect();
  expect(box.height).toBeLessThanOrEqual(420);
  expect(itemBox.bottom).toBeLessThanOrEqual(box.bottom);
  expect(itemBox.top).toBeGreaterThanOrEqual(box.top);
}

describe("native overlay presentation", () => {
  it("inherits palettes, focus, and menu states across stock, imported, and custom themes", async () => {
    mountMenu({
      children: <h3>Actions</h3>,
      items: [
        { id: "open", label: "Open", details: "Details" },
        { id: "delete", label: "Delete", details: "Permanently", variant: "danger" },
        { id: "disabled", label: "Unavailable", disabled: true },
        { id: "group", label: "Group", children: [{ id: "child", label: "Child" }] },
      ],
    });
    await openMenu();
    await openMenu("people-group");
    const child = item("Child", "people-group");
    await userEvent.hover(child);
    await userEvent.keyboard("{Home}");
    const themes = ["absolutely", "phosphor", "custom"].flatMap((name) => [name, `${name}-light`]);
    for (const theme of ["dark", "light", ...themes]) {
      root.dataset.theme = theme;
      root.dataset.themeMode = theme.endsWith("light") || theme === "light" ? "light" : "dark";
      if (theme.startsWith("custom")) {
        for (const [token, value] of Object.entries({
          muted: "rgb(120, 190, 160)",
          text: "rgb(220, 235, 210)",
          ring: "rgb(160, 130, 230)",
          popover: "rgb(32, 45, 38)",
          danger: "rgb(240, 135, 150)",
          "bg-hover": "rgb(45, 62, 51)",
        })) {
          root.style.setProperty(`--${token}`, value);
        }
      }
      document.getAnimations().forEach((animation) => animation.finish());
      const colors: [Element, "color" | "backgroundColor", string][] = [
        [surface(), "backgroundColor", "popover"],
        [item("Open"), "color", "text"],
        [details("Open"), "color", "muted"],
        [trigger("people-group").querySelector(".oc-menu-item__submenu-icon")!, "color", "muted"],
        [item("Delete"), "color", "danger"],
        [details("Delete"), "color", "danger"],
        [trigger("people-group"), "backgroundColor", "bg-hover"],
      ];
      for (const [element, property, token] of colors) {
        expect(getComputedStyle(element)[property], theme).toBe(color(`var(--${token})`));
      }
      expect(getComputedStyle(item("Open")).fontWeight, theme).toBe("400");
      expect(getComputedStyle(surface().querySelector("h3")!).fontWeight, theme).toBe("500");
      const itemStyle = getComputedStyle(item("Open"));
      for (const duration of itemStyle.transitionDuration.split(",")) {
        const seconds = Number.parseFloat(duration) / (duration.trim().endsWith("ms") ? 1000 : 1);
        expect(seconds, theme).toBeCloseTo(0.075, 6);
      }
      const rootFontSize = Number.parseFloat(getComputedStyle(root).fontSize);
      expect(getComputedStyle(child), theme).toMatchObject({
        outlineStyle: "solid",
        outlineWidth: `${rootFontSize * 0.1875}px`,
        outlineOffset: `${rootFontSize * 0.0625}px`,
        outlineColor: color("var(--ring)"),
      });
      expect(getComputedStyle(item("Unavailable")).opacity, theme).toBe("0.5");
    }
  });

  it("preserves a consumer height budget when its stylesheet loads before the overlay", async () => {
    await page.viewport(800, 700);
    const style = document.createElement("style");
    style.textContent = ".oc-menu.consumer-sized-menu { max-height: 500px; }";
    document.head.prepend(style);
    try {
      mountMenu({
        placement: "right-start",
        panelClass: "consumer-sized-menu",
        items: entries("Action", 24),
      });
      positionTrigger({ left: "200px", top: "50px" });
      await openMenu();
      // Measure the consumer budget, not WebKit's in-flight entry scale.
      finishElementAnimations(surface());
      expect(expectWithinViewport(surface()).height).toBe(500);
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(item("Action 24"));
      const last = item("Action 24").getBoundingClientRect();
      expect(last.bottom).toBeLessThanOrEqual(surface().getBoundingClientRect().bottom);
    } finally {
      style.remove();
    }
  });

  it.each([
    ["ltr", "low"],
    ["rtl", "low"],
    ["ltr", "bottom"],
    ["rtl", "bottom"],
    ["ltr", "middle"],
    ["rtl", "middle"],
  ] as const)(
    "fits nested menu actions within the viewport in %s near the %s",
    async (dir, position) => {
      await page.viewport(800, 600);
      const enlarged = position !== "low";
      const count = enlarged ? 28 : 10;
      if (enlarged) {
        root.style.fontSize = "24px";
      }
      mountMenu({
        dir,
        items: [{ id: "actions", label: "Actions", children: entries("Action", count, enlarged) }],
      });
      positionTrigger(
        position === "low"
          ? { left: "350px", top: "400px" }
          : { right: "8px", bottom: position === "bottom" ? "8px" : "250px" },
      );
      await openMenu();
      const parentBox = expectWithinViewport(surface());
      if (position === "bottom") {
        expect(parentBox.bottom).toBeLessThanOrEqual(trigger().getBoundingClientRect().top);
      }
      await openMenu("people-actions");
      const child = surface("people-actions");
      const last = item(`Action ${count}`, "people-actions");
      expectWithinViewport(child);
      if (!enlarged) {
        expect(child.scrollHeight).toBe(child.clientHeight);
        expectItemVisible(last, child);
        return;
      }
      expect(child.scrollHeight).toBeGreaterThan(child.clientHeight);
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(last);
      expectItemVisible(last, child);

      // Scrolling the menu can hide the focused action; End must reveal it again.
      child.scrollTo({ top: 0, behavior: "instant" });
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(last);
      expectItemVisible(last, child);
    },
  );

  it.each(["Escape", "selection", "Tab"])("keeps modal ownership after menu %s", async (action) => {
    const modal = mountModalMenu();
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    await openMenu("modal-menu");
    await openMenu("modal-menu-nested");
    const apply = item("Apply", "modal-menu-nested");
    const bounds = apply.getBoundingClientRect();
    expect(
      document
        .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        ?.closest("button"),
    ).toBe(apply);
    if (action === "Escape") {
      await userEvent.keyboard("{Escape}");
      await phase(surface("modal-menu-nested"), "hidden");
      expect(surface("modal-menu").matches(":popover-open")).toBe(true);
      expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    }
    if (action === "selection") {
      await userEvent.click(apply);
    } else {
      if (action === "Tab") {
        await expect.element(apply).toHaveFocus();
      }
      await userEvent.keyboard(`{${action}}`);
    }
    await phase(surface("modal-menu"), "hidden");
    expect(modal.open).toBe(true);
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    if (action === "Escape") {
      await userEvent.keyboard("{Escape}");
      expect(modal.open).toBe(false);
    }
  });

  it("uses high-contrast borders and focus in forced colors", async () => {
    await emulateOverlayMedia({ forcedColors: "active" });
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    mountMenu();
    await openMenu();
    expect(getComputedStyle(surface()).boxShadow).toBe("none");
    expect(getComputedStyle(surface()).borderTopColor).toBe(color("CanvasText"));
    await userEvent.keyboard("{End}");
    expect(getComputedStyle(item("Archive")).outlineColor).toBe(color("Highlight"));
  });

  it("disables menu and popover motion for reduced motion", async () => {
    await emulateOverlayMedia({ reducedMotion: "reduce" });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    mountMenu();
    let popover!: PopoverHandle;
    render(() => (
      <Popover id="motion-popover" label="Popover" ref={(value) => (popover = value)}>
        Content
      </Popover>
    ));
    flush();
    await openMenu();
    popover.show();
    await phase(popover.overlay.surface, "open");
    for (const element of [surface(), item("Archive"), popover.overlay.surface]) {
      expect(getComputedStyle(element)).toMatchObject({
        animationName: "none",
        transitionDuration: "0s",
      });
      expect(element.getAnimations()).toHaveLength(0);
    }
  });
});
