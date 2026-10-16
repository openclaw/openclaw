import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { copyToClipboard } from "../lib/clipboard.ts";
import "./modal-dialog.ts";
import { mountNativeLinkMenu } from "./native-link-menu.runtime.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function modalFixture(shadow = false) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.style.setProperty("--openclaw-modal-show-duration", "0ms");
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
