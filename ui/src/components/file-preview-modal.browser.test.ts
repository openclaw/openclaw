import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import type { OpenClawModalDialog } from "./modal-dialog.tsx";
import "./file-preview-modal.tsx";

const browserMode = "__vitest_browser__" in globalThis;
const initialFilePath =
  "templates/customer-success/quarterly-reviews/complete-digest-template-with-a-long-name.md";

function file(path: string, contents = "", size = "0 B", message?: string) {
  return { path, contents, size, message };
}

const files = [
  file(initialFilePath, "Review the complete support-file contents.", "2.1 KB"),
  file("filters/auto-senders.txt", "noreply@example.com", "418 B"),
  file("assets/empty-preview.png"),
];

afterEach(() => {
  document.body.replaceChildren();
});

async function resolveRenderedDialog(modal: OpenClawModalDialog) {
  await modal.updateComplete;
  await nextFrame();
  const dialog = modal.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  // The modal opens at 80% scale; measure the settled dialog, not its first animation frame.
  const animations = dialog!.getAnimations();
  for (const animation of animations) {
    animation.finish();
  }
  await Promise.all(animations.map((animation) => animation.finished));
  await nextFrame();
  return dialog!;
}

async function mountPreview(width: number, activePath = initialFilePath) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);
  const preview = document.createElement("openclaw-file-preview-modal");
  preview.style.setProperty("--openclaw-modal-show-duration", "150ms");
  preview.files = files;
  preview.activePath = activePath;
  document.body.append(preview);
  await preview.updateComplete;
  const ownerDialog = preview.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(ownerDialog).toBeInstanceOf(HTMLElement);
  const dialog = await resolveRenderedDialog(ownerDialog!);
  return { preview, dialog };
}

async function mountModal(width: number, variant: string, modalWidth: string) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);
  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Preview";
  modal.style.setProperty("--openclaw-modal-show-duration", "150ms");
  modal.style.setProperty("--openclaw-modal-width", modalWidth);
  modal.className = variant;
  modal.textContent = "Preview";
  document.body.append(modal);
  return await resolveRenderedDialog(modal);
}

function bounds(parent: ParentNode, selector: string) {
  return element(parent, selector).getBoundingClientRect();
}

function element(parent: ParentNode, selector: string) {
  const found = parent.querySelector<HTMLElement>(selector);
  expect(found).toBeInstanceOf(HTMLElement);
  return found!;
}

function expectHorizontalFit(inner: DOMRect, outer: DOMRect) {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 1);
  expect(inner.right).toBeLessThanOrEqual(outer.right + 1);
}

function expectVerticalFit(rect: DOMRect) {
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
}

function expectFooter(preview: HTMLElement, dialogBounds: DOMRect) {
  const footer = bounds(preview, ".foot");
  const close = bounds(preview, ".foot openclaw-modal-actions button");
  expect(footer.top).toBeGreaterThanOrEqual(bounds(preview, ".body").bottom - 1);
  expect(close.right).toBeLessThanOrEqual(dialogBounds.right + 1);
  expect(close.bottom).toBeLessThanOrEqual(dialogBounds.bottom + 1);
}

describe.runIf(browserMode)("file preview modal responsive layout", () => {
  it("keeps shared copy feedback styling while hovered", async () => {
    const { preview } = await mountPreview(1280);
    const { userEvent } = await import("vitest/browser");
    const button = preview.querySelector<HTMLButtonElement>(".chat-copy-btn")!;
    preview.style.setProperty("--ok", "rgb(0, 128, 0)");
    preview.style.setProperty("--ok-subtle", "rgb(220, 255, 220)");
    preview.style.setProperty("--danger", "rgb(192, 0, 0)");
    preview.style.setProperty("--danger-subtle", "rgb(255, 220, 220)");
    preview.style.setProperty("--text-strong", "rgb(32, 32, 32)");
    await userEvent.hover(button);
    for (const [state, color, background] of [
      ["copied", "rgb(0, 128, 0)", "rgb(220, 255, 220)"],
      ["error", "rgb(192, 0, 0)", "rgb(255, 220, 220)"],
    ] as const) {
      button.dataset.copyState = state;
      expect(getComputedStyle(button).color).toBe(color);
      expect(getComputedStyle(button).borderTopColor).toBe(background);
      expect(getComputedStyle(button).backgroundColor).toBe(background);
    }
    button.dataset.copyState = "copying";
    expect(getComputedStyle(button)).toMatchObject({ opacity: "0", pointerEvents: "none" });
    delete button.dataset.copyState;
    expect(getComputedStyle(button).color).toBe("rgb(32, 32, 32)");
    expect(preview.querySelector(".chat-copy-btn__icon")?.getBoundingClientRect().width).toBe(16);
  });

  it.each([320])("keeps source and copy visible at a %dpx viewport", async (width) => {
    const { preview, dialog } = await mountPreview(width);
    const search = preview.querySelector<HTMLInputElement>(".search");
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect(preview.querySelector(".chat-copy-btn")).toBeInstanceOf(HTMLButtonElement);
    const source = element(preview, ".code-chunk");
    const dialogBounds = dialog.getBoundingClientRect();
    expectFooter(preview, dialogBounds);
    const listBounds = bounds(preview, ".list");
    const detailBounds = bounds(preview, ".detail");
    const copyBounds = bounds(preview, ".chat-copy-btn");
    const searchBounds = bounds(preview, ".search");
    const sourceBounds = bounds(preview, ".code-chunk");
    const activeItemBounds = bounds(preview, ".item.is-active");
    const titleBounds = bounds(preview, ".title");
    const sourceTextRange = document.createRange();
    sourceTextRange.selectNodeContents(source);
    const sourceTextBounds = sourceTextRange.getBoundingClientRect();
    expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expectVerticalFit(dialogBounds);
    expect(detailBounds.top).toBeGreaterThanOrEqual(listBounds.bottom - 1);
    expect(detailBounds.width).toBeGreaterThan(200);
    expectVerticalFit(copyBounds);
    expectHorizontalFit(copyBounds, dialogBounds);
    expect(searchBounds.width).toBeGreaterThan(80);
    expect(searchBounds.left).toBeGreaterThanOrEqual(0);
    expect(searchBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
    expectVerticalFit(searchBounds);
    expectHorizontalFit(activeItemBounds, dialogBounds);
    expectHorizontalFit(titleBounds, dialogBounds);
    expect(preview.querySelector(".title")?.textContent).toBe(initialFilePath);
    expect(sourceBounds.width).toBeGreaterThan(100);
    expect(sourceBounds.height).toBeGreaterThan(0);
    expect(sourceBounds.top).toBeGreaterThanOrEqual(0);
    expect(sourceBounds.top).toBeLessThan(window.innerHeight);
    expect(sourceTextBounds.width).toBeGreaterThan(0);
    expect(sourceTextBounds.height).toBeGreaterThan(0);
    expectHorizontalFit(sourceTextBounds, dialogBounds);
    expectVerticalFit(sourceTextBounds);
    expect(source?.textContent).toContain("Review the complete support-file contents.");
    const selected = vi.fn();
    preview.addEventListener("file-preview-select", selected);
    search?.focus();
    const { userEvent } = await import("vitest/browser");
    await userEvent.keyboard("{ArrowDown}");
    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.calls[0]?.[0].detail).toBe("filters/auto-senders.txt");
  });

  it.each([375])("keeps an empty non-text preview reachable at a %dpx viewport", async (width) => {
    const { preview, dialog } = await mountPreview(width, "assets/empty-preview.png");
    expect(element(preview, ".title").textContent).toBe("assets/empty-preview.png");
    expect(element(preview, ".chip.accent").textContent).toBe("PNG");
    expect(preview.querySelector(".chat-copy-btn")).toBeNull();
    expect(preview.querySelector(".code-chunk")?.textContent).toBe("");
    const dialogBounds = dialog.getBoundingClientRect();
    expectFooter(preview, dialogBounds);
    expectHorizontalFit(bounds(preview, ".detail"), dialogBounds);
    expectVerticalFit(bounds(preview, ".detail-body"));
  });

  it("preserves the desktop side-by-side file layout", async () => {
    const { preview, dialog } = await mountPreview(1280);
    const listBounds = bounds(preview, ".list");
    const detailBounds = bounds(preview, ".detail");
    expect(listBounds.width).toBeCloseTo(360, 0);
    expect(detailBounds.left).toBeGreaterThanOrEqual(listBounds.right - 1);
    expect(detailBounds.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right + 1);
  });

  it.each([
    [1280, "fullscreen", "min(1040px, calc(100vw - 32px))", 1259, true],
    [390, "fullscreen", "min(1040px, calc(100vw - 32px))", 369, true],
    [390, "", "200px", 200, false],
    [390, "drawer", "min(460px, 100vw)", 390, false],
    [1280, "drawer", "min(460px, 100vw)", 460, false],
  ] as const)(
    "preserves modal width at %dpx (%s)",
    async (viewport, variant, modalWidth, expected, minimum) => {
      const dialog = await mountModal(viewport, variant, modalWidth);
      const width = expect(dialog.getBoundingClientRect().width);
      if (minimum) {
        width.toBeGreaterThanOrEqual(expected);
      } else {
        width.toBeCloseTo(expected, 0);
      }
    },
  );
});

describe.runIf(browserMode)("skill bundle file preview", () => {
  it.each([390, 768])(
    "renders complete Markdown and navigable folders without search or Copy at %dpx",
    async (width) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(width, 844);
      const trigger = document.createElement("button");
      trigger.textContent = "Open skill";
      document.body.append(trigger);
      trigger.focus();
      const preview = document.createElement("openclaw-file-preview-modal");
      preview.layout = "document";
      preview.label = "Operator guide";
      preview.activePath = "SKILL.md";
      const long =
        "# Full reference\n" +
        "Complete instructions.\n".repeat(3000) +
        "Last complete instruction.";
      preview.files = [
        file(
          "SKILL.md",
          `${long}\n\n\`\`\`js\nwindow.untrusted = true;\n\`\`\`\n<script>window.untrusted=true</script>`,
          "100 B",
        ),
        file("references/guide.md", "# Reference", "64 KB"),
        file("scripts/unlinked.py", "print('read only')", "20 B"),
        file("assets/image.png", "", "4 B", "Binary file cannot be previewed"),
      ];
      preview.addEventListener("file-preview-select", (event: Event) => {
        preview.activePath = (event as CustomEvent<string>).detail;
      });
      preview.addEventListener("file-preview-close", () => preview.remove());
      document.body.append(preview);
      await preview.updateComplete;
      const owner = preview.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
      const dialog = await resolveRenderedDialog(owner);
      expect(
        preview.querySelector(
          ".search, openclaw-modal-actions, .chips, .item-meta, .state, .list-section, .detail-head, .foot, .chat-copy-btn, .code-block-copy, script",
        ),
      ).toBeNull();
      const close = element(preview, '[aria-label="Close"]');
      expect(close.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(preview.querySelectorAll(".item")).toHaveLength(4);
      expect(preview.querySelectorAll("details")).toHaveLength(3);
      const markdown = element(preview, ".markdown").textContent;
      expect(markdown).toContain("Last complete instruction.");
      expect(markdown).not.toContain("truncated");
      const binary = element(preview, '[data-path="assets/image.png"]');
      binary.click();
      await preview.updateComplete;
      expect(element(preview, ".detail-body").textContent).toContain(
        "Binary file cannot be previewed",
      );
      const list = bounds(preview, ".list");
      const detail = bounds(preview, ".detail");
      expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1);
      expect(detail.width).toBeGreaterThan(200);
      if (width <= 640) {
        expect(detail.top).toBeGreaterThanOrEqual(list.bottom - 1);
      } else {
        expect(detail.left).toBeGreaterThanOrEqual(list.right - 1);
      }
      binary.focus();
      await userEvent.keyboard("{ArrowDown}");
      await preview.updateComplete;
      expect(preview.activePath).toBe("references/guide.md");
      if (width === 390) {
        close.click();
      } else {
        await userEvent.keyboard("{Escape}");
      }
      await expect.poll(() => preview.isConnected).toBe(false);
      await expect.poll(() => document.activeElement).toBe(trigger);
    },
  );
});
