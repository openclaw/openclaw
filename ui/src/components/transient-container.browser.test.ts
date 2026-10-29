import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { copyToClipboard } from "../lib/clipboard.ts";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { emulateOverlayMedia } from "../test-helpers/overlay-browser-media.ts";
import "./modal-dialog.ts";
import { mountNativeLinkMenu } from "./native-link-menu.runtime.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function modalFixture(shadow = false, variant = "", animated = false) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.className = variant;
  if (!animated) {
    modal.style.setProperty("--openclaw-modal-show-duration", "0ms");
  }
  const content = document.createElement("section");
  const root = shadow ? content.attachShadow({ mode: "open" }) : content;
  const trigger = document.createElement("a");
  trigger.href = "https://example.com/report";
  trigger.textContent = "Report";
  root.append(trigger);
  modal.append(content);
  document.body.append(modal);
  await modal.updateComplete;
  const dialog = modal.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  return { modal, dialog, trigger };
}

describe.runIf("__vitest_browser__" in globalThis)("native modal transient surfaces", () => {
  it("keeps native-link menu actions clickable without dismissing the modal", async () => {
    const { page } = await import("vitest/browser");
    const { modal, dialog, trigger } = await modalFixture();
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
    await page
      .elementLocator(menu!)
      .getByRole("menuitem", { name: "Open in Browser Panel" })
      .click();
    expect(openInline).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
  });

  it.each([
    {
      variant: "",
      shadow: false,
      width: 900,
      height: 700,
      animated: false,
      edge: false,
      reduced: false,
    },
    {
      variant: "",
      shadow: true,
      width: 900,
      height: 700,
      animated: true,
      edge: false,
      reduced: false,
    },
    {
      variant: "drawer",
      shadow: false,
      width: 900,
      height: 700,
      animated: true,
      edge: false,
      reduced: false,
    },
    {
      variant: "drawer drawer--floating",
      shadow: true,
      width: 900,
      height: 700,
      animated: true,
      edge: false,
      reduced: false,
    },
    {
      variant: "",
      shadow: true,
      width: 360,
      height: 640,
      animated: true,
      edge: true,
      reduced: false,
    },
    {
      variant: "drawer",
      shadow: true,
      width: 360,
      height: 640,
      animated: true,
      edge: true,
      reduced: false,
    },
    {
      variant: "",
      shadow: false,
      width: 900,
      height: 700,
      animated: true,
      edge: false,
      reduced: true,
    },
    {
      variant: "drawer",
      shadow: true,
      width: 900,
      height: 700,
      animated: true,
      edge: true,
      reduced: true,
    },
  ])(
    "keeps viewport-point actions hittable after settling ($variant, shadow=$shadow, $width, edge=$edge, reduced=$reduced)",
    async ({ variant, shadow, width, height, animated, edge, reduced }) => {
      const { page } = await import("vitest/browser");
      const initialViewport = [innerWidth, innerHeight] as const;
      onTestFinished(async () => {
        await page.viewport(...initialViewport);
        await emulateOverlayMedia({ reducedMotion: "no-preference" });
      });
      await page.viewport(width, height);
      await emulateOverlayMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      const { modal, dialog, trigger } = await modalFixture(shadow, variant, animated);
      await expect.poll(() => dialog.dataset.phase).toBe("open");
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
      await nextFrame();
      const order: string[] = [];
      const copy = vi.fn(async () => {
        order.push("copy");
      });
      vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
      const labels = [
        ["inline", "Open in Browser Panel"],
        ["external", "Open in Default Browser"],
        ["copy", "Copy Link"],
      ] as const;
      for (const [action, label] of labels) {
        order.length = 0;
        const openInline = vi.fn(() => {
          order.push("inline");
        });
        const openExternal = vi.fn(() => {
          order.push("external");
        });
        const rect = trigger.getBoundingClientRect();
        const x = edge ? innerWidth - 1 : rect.left;
        const y = edge ? innerHeight - 1 : rect.bottom;
        const menu = mountNativeLinkMenu({
          path: [trigger, dialog, modal, document, window],
          anchor: trigger,
          url: new URL(trigger.href),
          x,
          y,
          close: (current) => {
            // Removal and disposal can both notify close; record the DOM effect once.
            if (current.isConnected) {
              order.push("close");
              current.remove();
            }
          },
          openExternal,
          openInline,
        });
        expect(menu).not.toBeNull();
        await menu!.updateComplete;
        const surface = menu!.querySelector<HTMLElement>('[role="menu"]')!;
        await expect.poll(() => surface.matches(":popover-open")).toBe(true);
        await nextFrame();
        const point = menu!.querySelector<HTMLElement>(".oc-menu-trigger")!;
        const item = menu!.querySelector<HTMLElement>('[data-value="' + action + '"]')!;
        const pointRect = point.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(
          itemRect.x + itemRect.width / 2,
          itemRect.y + itemRect.height / 2,
        );
        const geometry = JSON.stringify({
          viewport: [innerWidth, innerHeight],
          dialog: dialog.getBoundingClientRect().toJSON(),
          scale: getComputedStyle(dialog).scale,
          transform: getComputedStyle(dialog).transform,
          point: pointRect.toJSON(),
          surface: surfaceRect.toJSON(),
          item: itemRect.toJSON(),
          hit: hit?.outerHTML,
        });
        expect(dialog.contains(menu), geometry).toBe(true);
        expect(pointRect.x, geometry).toBeCloseTo(Math.max(8, Math.min(x, innerWidth - 272)), 1);
        expect(pointRect.y, geometry).toBeCloseTo(Math.max(8, Math.min(y, innerHeight - 144)), 1);
        for (const bounds of [surfaceRect, itemRect]) {
          expect(
            [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite),
            geometry,
          ).toBe(true);
          expect(bounds.width, geometry).toBeGreaterThan(0);
          expect(bounds.height, geometry).toBeGreaterThan(0);
          expect(bounds.left, geometry).toBeGreaterThanOrEqual(0);
          expect(bounds.top, geometry).toBeGreaterThanOrEqual(0);
          expect(bounds.right, geometry).toBeLessThanOrEqual(innerWidth);
          expect(bounds.bottom, geometry).toBeLessThanOrEqual(innerHeight);
        }
        expect(hit !== null && item.contains(hit), geometry).toBe(true);
        await page
          .elementLocator(menu!)
          .getByRole("menuitem", { name: label, exact: true })
          .click();
        expect(order).toEqual(["close", action]);
        expect(openInline).toHaveBeenCalledTimes(action === "inline" ? 1 : 0);
        expect(openExternal).toHaveBeenCalledTimes(action === "external" ? 1 : 0);
        expect(dialog.open).toBe(true);
        expect(menu!.isConnected).toBe(false);
        const root = trigger.getRootNode();
        expect(root instanceof ShadowRoot ? root.activeElement : document.activeElement).toBe(
          trigger,
        );
      }
      expect(copy).toHaveBeenCalledExactlyOnceWith(trigger.href);
    },
  );

  it.each([false, true])(
    "keeps a modal hovercard interactive and retires it on disconnect (shadow=%s)",
    async (shadow) => {
      const { page } = await import("vitest/browser");
      const { modal, dialog, trigger } = await modalFixture(shadow);
      const controller = new PortaledHovercardController(() => controller.reset());
      onTestFinished(() => controller.reset());
      const card = createPortaledHovercard("modal-preview", "preview");
      card.style.cssText = "position: fixed; inset: auto; margin: 0; padding: 8px";
      const link = document.createElement("a");
      link.href = "#preview";
      link.textContent = "Read preview";
      const activate = vi.fn((event: MouseEvent) => event.preventDefault());
      link.addEventListener("click", activate);
      card.append(link);
      controller.markTrigger(trigger);
      controller.mount(trigger, card, "vertical");
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
    const dispose = installTitleTooltips(document);
    onTestFinished(dispose);
    trigger.title = "Read the report";
    trigger.blur();
    trigger.focus();
    await expect.poll(() => modal.querySelector("openclaw-tooltip")).not.toBeNull();
    const tooltip = modal.querySelector("openclaw-tooltip")!;
    await tooltip.updateComplete;
    await expect
      .poll(() => tooltip.shadowRoot?.querySelector(".tooltip-surface")?.matches(":popover-open"))
      .toBe(true);
    await expect
      .element(tooltip.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!)
      .toBeVisible();
  });

  it("selects clipboard fallback text inside the active native modal", async () => {
    const { dialog } = await modalFixture();
    vi.stubGlobal("navigator", {});
    const exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
      const selection = document.activeElement;
      expect(selection).toBeInstanceOf(HTMLTextAreaElement);
      expect(dialog.contains(selection)).toBe(true);
      const textarea = selection as HTMLTextAreaElement;
      expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe(
        "Report URL",
      );
      return true;
    });
    expect(await copyToClipboard("Report URL")).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(dialog.querySelector("textarea")).toBeNull();
  });
});
