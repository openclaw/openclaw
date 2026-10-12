import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { emulateOverlayMedia } from "../../test-helpers/overlay-browser-media.ts";
import {
  item,
  mountMenu,
  openMenu,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.ts";
import { Menu } from "./menu.tsx";
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

function tokenColor(token: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(--${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function finishColorTransitions() {
  for (const animation of document.getAnimations()) {
    animation.finish();
  }
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
    for (const theme of [
      "dark",
      "light",
      "absolutely",
      "absolutely-light",
      "phosphor",
      "phosphor-light",
      "custom",
      "custom-light",
    ]) {
      root.dataset.theme = theme;
      root.dataset.themeMode = theme.endsWith("light") || theme === "light" ? "light" : "dark";
      if (theme.startsWith("custom")) {
        for (const [token, value] of Object.entries({
          muted: "rgb(120, 190, 160)",
          text: "rgb(220, 235, 210)",
          accent: "rgb(190, 130, 220)",
          ring: "rgb(160, 130, 230)",
          popover: "rgb(32, 45, 38)",
          danger: "rgb(240, 135, 150)",
          "bg-hover": "rgb(45, 62, 51)",
        })) {
          root.style.setProperty(`--${token}`, value);
        }
      }
      finishColorTransitions();
      expect(getComputedStyle(surface()).backgroundColor, theme).toBe(tokenColor("popover"));
      expect(getComputedStyle(item("Open")).color, theme).toBe(tokenColor("text"));
      expect(
        getComputedStyle(item("Open").querySelector(".oc-menu-item__details")!).color,
        theme,
      ).toBe(tokenColor("muted"));
      expect(
        getComputedStyle(trigger("people-group").querySelector(".oc-menu-item__submenu-icon")!)
          .color,
        theme,
      ).toBe(tokenColor("muted"));
      expect(getComputedStyle(item("Open")).fontWeight, theme).toBe("400");
      expect(getComputedStyle(surface().querySelector("h3")!).fontWeight, theme).toBe("500");
      const itemStyle = getComputedStyle(item("Open"));
      const motionContext = JSON.stringify({
        theme,
        duration: itemStyle.transitionDuration,
        property: itemStyle.transitionProperty,
        token: itemStyle.getPropertyValue("--control-ui-transition-fast"),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      for (const duration of itemStyle.transitionDuration.split(",")) {
        const seconds = Number.parseFloat(duration) / (duration.trim().endsWith("ms") ? 1000 : 1);
        expect(seconds, motionContext).toBeCloseTo(0.075, 6);
      }
      const rootFontSize = Number.parseFloat(getComputedStyle(root).fontSize);
      const focused = getComputedStyle(child);
      expect(focused.outlineStyle, theme).toBe("solid");
      expect(focused.outlineWidth, theme).toBe(`${rootFontSize * 0.1875}px`);
      expect(focused.outlineOffset, theme).toBe(`${rootFontSize * 0.0625}px`);
      expect(focused.outlineColor, theme).toBe(tokenColor("ring"));
      expect(getComputedStyle(item("Delete")).color, theme).toBe(tokenColor("danger"));
      expect(
        getComputedStyle(item("Delete").querySelector(".oc-menu-item__details")!).color,
        theme,
      ).toBe(tokenColor("danger"));
      expect(getComputedStyle(item("Unavailable")).opacity, theme).toBe("0.5");
      expect(getComputedStyle(trigger("people-group")).backgroundColor, theme).toBe(
        tokenColor("bg-hover"),
      );
    }
  });

  it.each(["ltr", "rtl"] as const)(
    "flips a large nested menu within the viewport in %s at enlarged text",
    async (dir) => {
      await page.viewport(800, 600);
      root.style.fontSize = "24px";
      mountMenu({
        dir,
        items: [
          {
            id: "large",
            label: "Many actions",
            children: Array.from({ length: 28 }, (_, index) => ({
              id: `action-${index}`,
              label: `Action ${String(index + 1).padStart(2, "0")}`,
            })),
          },
        ],
      });
      Object.assign(trigger().style, { position: "fixed", right: "8px", bottom: "8px" });
      await openMenu();
      const parentBox = expectWithinViewport(surface());
      expect(parentBox.bottom).toBeLessThanOrEqual(trigger().getBoundingClientRect().top);
      await openMenu("people-large");
      const childBox = expectWithinViewport(surface("people-large"));
      expect(childBox.height).toBeLessThanOrEqual(420);
      expect(surface("people-large").scrollHeight).toBeGreaterThan(
        surface("people-large").clientHeight,
      );
      await userEvent.keyboard("{End}");
      const last = item("Action 28", "people-large");
      expect(document.activeElement).toBe(last);
      const currentChildBox = expectWithinViewport(surface("people-large"));
      const lastBox = last.getBoundingClientRect();
      expect(currentChildBox.height).toBeLessThanOrEqual(420);
      expect(lastBox.bottom).toBeLessThanOrEqual(currentChildBox.bottom);
      expect(lastBox.top).toBeGreaterThanOrEqual(currentChildBox.top);
    },
  );

  it("keeps nested menus above a modal and consumes only the deepest Escape", async () => {
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
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    await openMenu("modal-menu");
    await openMenu("modal-menu-nested");
    const action = item("Apply", "modal-menu-nested");
    const bounds = action.getBoundingClientRect();
    expect(
      document
        .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        ?.closest("button"),
    ).toBe(action);
    await userEvent.keyboard("{Escape}");
    await phase(surface("modal-menu-nested"), "hidden");
    expect(surface("modal-menu").matches(":popover-open")).toBe(true);
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await phase(surface("modal-menu"), "hidden");
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(modal.open).toBe(false);
  });

  it.each(["selection", "Tab"])("keeps the modal open after menu %s", async (action) => {
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
    await openMenu("modal-menu");
    await openMenu("modal-menu-nested");
    if (action === "selection") {
      await userEvent.click(item("Apply", "modal-menu-nested"));
    } else {
      await userEvent.keyboard("{Tab}");
    }
    await phase(surface("modal-menu"), "hidden");
    expect(modal.open).toBe(true);
    expect(modal.querySelector("dialog")!.matches(":modal")).toBe(true);
  });

  it("uses high-contrast borders and focus in forced colors", async () => {
    await emulateOverlayMedia({ forcedColors: "active" });
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    mountMenu();
    await openMenu();
    expect(getComputedStyle(surface()).boxShadow).toBe("none");
    const probe = document.createElement("span");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    expect(getComputedStyle(surface()).borderTopColor).toBe(getComputedStyle(probe).color);
    probe.style.color = "Highlight";
    await userEvent.keyboard("{End}");
    expect(getComputedStyle(item("Archive")).outlineColor).toBe(getComputedStyle(probe).color);
    probe.remove();
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
      expect(getComputedStyle(element).animationName).toBe("none");
      expect(getComputedStyle(element).transitionDuration).toBe("0s");
      expect(element.getAnimations()).toHaveLength(0);
    }
  });
});
