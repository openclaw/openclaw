import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { copyToClipboard } from "../lib/clipboard.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { item, mountMenu, openMenu, surface as menuSurface } from "../test-helpers/solid-menu.tsx";
import "./modal-dialog.tsx";
import { mountNativeLinkMenu } from "./native-link-menu.runtime.tsx";
import { controlsForHovercard } from "./portaled-hovercard-focus.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";
import { installTitleTooltips } from "./tooltip-title.ts";
import "../styles.css";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function modalFixture(shadow = false, variant = "") {
  const { page } = await import("vitest/browser");
  const modal = document.createElement("openclaw-modal-dialog");
  modal.className = variant;
  modal.style.setProperty("--openclaw-modal-show-duration", "0ms");
  modal.innerHTML = '<section><a href="https://example.com/report">Report</a></section>';
  const trigger = modal.querySelector("a")!;
  if (shadow) {
    modal.querySelector("section")!.attachShadow({ mode: "open" }).append(trigger);
  }
  document.body.append(modal);
  await modal.updateComplete;
  const dialog = modal.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  return { modal, dialog, trigger, page };
}

describe.runIf("__vitest_browser__" in globalThis)("native modal transient surfaces", () => {
  it("keeps native-link menu actions spaced and clickable without dismissing the modal", async () => {
    const { modal, dialog, trigger, page } = await modalFixture();
    const openInline = vi.fn();
    const rect = trigger.getBoundingClientRect();
    const menu = mountNativeLinkMenu({
      path: [trigger, dialog, modal, document, window],
      anchor: trigger,
      url: new URL(trigger.href),
      x: rect.left,
      y: rect.bottom,
      close: (current) => current.remove(),
      openExternal: vi.fn(),
      openInline,
    });
    expect(menu).not.toBeNull();
    await menu!.updateComplete;
    finishElementAnimations(dialog);
    const actions = menu!.querySelectorAll<HTMLElement>(".session-menu__item");
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      await expect
        .poll(() => {
          const icon = action.querySelector(".session-menu__icon")!.getBoundingClientRect();
          const label = action.querySelector(".session-menu__text")!.getBoundingClientRect();
          return label.left - icon.right;
        })
        .toBeCloseTo(6, 1);
    }
    await page
      .elementLocator(menu!)
      .getByRole("menuitem", { name: "Open in browser panel" })
      .click();
    expect(openInline).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
  });

  it.each([
    { variant: "", shadow: false },
    { variant: "drawer", shadow: true },
    { variant: "drawer drawer--floating", shadow: true },
  ])(
    "keeps point anchors viewport-relative in a settled modal ($variant, shadow=$shadow)",
    async ({ variant, shadow }) => {
      const { modal, dialog, trigger, page } = await modalFixture(shadow, variant);
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
      const openInline = vi.fn();
      const rect = trigger.getBoundingClientRect();
      const menu = mountNativeLinkMenu({
        path: [trigger, dialog, modal, document, window],
        anchor: trigger,
        url: new URL(trigger.href),
        x: rect.left,
        y: rect.bottom,
        close: (current) => current.remove(),
        openExternal: vi.fn(),
        openInline,
      });
      await menu!.updateComplete;
      const surface = menu!.querySelector<HTMLElement>('[role="menu"]')!;
      await expect.poll(() => surface.matches(":popover-open")).toBe(true);
      const point = menu!.querySelector(".oc-menu-trigger")!.getBoundingClientRect();
      expect(point.x).toBeCloseTo(Math.max(8, rect.left), 1);
      expect(point.y).toBeCloseTo(Math.max(8, rect.bottom), 1);
      await page
        .elementLocator(menu!)
        .getByRole("menuitem", { name: "Open in browser panel" })
        .click();
      expect(openInline).toHaveBeenCalledOnce();
      expect(dialog.open).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps a modal hovercard interactive and retires it on disconnect (shadow=%s)",
    async (shadow) => {
      const { modal, dialog, trigger, page } = await modalFixture(shadow);
      const controller = createPortaledHovercardOwner(() => controller.reset());
      onTestFinished(() => controller.reset());
      const card = createPortaledHovercard("modal-preview", "preview");
      card.style.cssText = "position: fixed; inset: auto; margin: 0; padding: 8px";
      card.innerHTML = '<a href="#preview">Read preview</a>';
      const link = card.querySelector("a")!;
      const activate = vi.fn((event: MouseEvent) => event.preventDefault());
      link.addEventListener("click", activate);
      const releaseControl = controlsForHovercard(card).registerSource(() => [link]);
      controller.markTrigger(trigger);
      controller.mount(trigger, card, "vertical", true, releaseControl);
      await page.elementLocator(link).click();
      expect(activate).toHaveBeenCalledOnce();
      expect(dialog.open).toBe(true);
      modal.remove();
      await Promise.resolve();
      expect(controller.card).toBeNull();
    },
  );

  it("shows title hints inside the native modal", async () => {
    const { modal, trigger } = await modalFixture();
    onTestFinished(installTitleTooltips(document));
    trigger.title = "Read the report";
    trigger.blur();
    trigger.focus();
    await expect.poll(() => modal.querySelector("openclaw-tooltip")).not.toBeNull();
    const tooltip = modal.querySelector("openclaw-tooltip")!;
    await tooltip.updateComplete;
    const surface = tooltip.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!;
    await expect.poll(() => surface.matches(":popover-open")).toBe(true);
    await expect.element(surface).toBeVisible();
  });

  it("selects clipboard fallback text inside the active native modal", async () => {
    const { dialog } = await modalFixture();
    vi.stubGlobal("navigator", {});
    const exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
      const selection = document.activeElement;
      expect(selection).toBeInstanceOf(HTMLTextAreaElement);
      expect(dialog.contains(selection)).toBe(true);
      const textarea = selection as HTMLTextAreaElement;
      const { value, selectionStart, selectionEnd } = textarea;
      expect(value.slice(selectionStart, selectionEnd)).toBe("Report URL");
      return true;
    });
    expect(await copyToClipboard("Report URL")).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(dialog.querySelector("textarea")).toBeNull();
  });
});

describe.runIf("__vitest_browser__" in globalThis)("native menu clipboard fallback", () => {
  it("keeps the menu open when rejected clipboard writes fall back to selection", async () => {
    const { page } = await import("vitest/browser");
    const copied = vi.fn();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    const exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
      expect(menuSurface().contains(document.activeElement)).toBe(true);
      return false;
    });
    const view = mountMenu({
      items: [{ id: "copy", label: "Copy link", closeOnSelect: false }],
      onSelect: () => {
        const result = copyToClipboard("https://example.com/pr/42");
        item("Copy link").disabled = true;
        void result.then(copied);
      },
    });
    onTestFinished(() => view.unmount());
    await openMenu();
    await page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect.poll(() => copied.mock.calls).toEqual([[false]]);
    expect(exec).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(view.handle.overlay.open).toBe(true);
  });
});
