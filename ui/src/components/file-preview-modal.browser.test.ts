import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { OpenClawFilePreviewModal } from "./file-preview-modal.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";
import "./file-preview-modal-registration.ts";

const browserMode = "__vitest_browser__" in globalThis;
const initialFilePath =
  "templates/customer-success/quarterly-reviews/complete-digest-template-with-a-long-name.md";

const files = [
  {
    path: initialFilePath,
    size: "2.1 KB",
    contents: "Review the complete support-file contents.",
  },
  {
    path: "filters/auto-senders.txt",
    size: "418 B",
    contents: "noreply@example.com",
  },
  {
    path: "assets/empty-preview.png",
    size: "0 B",
    contents: "",
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

async function resolveRenderedDialog(modal: OpenClawModalDialog) {
  await modal.updateComplete;
  const webAwesomeDialog = modal.shadowRoot?.querySelector<WaDialog>("wa-dialog");
  expect(webAwesomeDialog).toBeInstanceOf(HTMLElement);
  await webAwesomeDialog?.updateComplete;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const dialog = webAwesomeDialog?.shadowRoot?.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  // Web Awesome opens at 80% scale; measure the settled dialog, not its first animation frame.
  await Promise.all(dialog!.getAnimations().map((animation) => animation.finished));
  return dialog!;
}

async function mountPreview(width: number, activePath = initialFilePath, previewFiles = files) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);

  const preview = document.createElement("openclaw-file-preview-modal") as OpenClawFilePreviewModal;
  preview.style.setProperty("--wa-transition-normal", "150ms");
  preview.files = previewFiles;
  preview.activePath = activePath;
  document.body.append(preview);
  await preview.updateComplete;

  const ownerDialog =
    preview.shadowRoot?.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(ownerDialog).toBeInstanceOf(HTMLElement);
  const dialog = await resolveRenderedDialog(ownerDialog!);
  return { preview, dialog };
}

async function mountModal(
  width: number,
  options: {
    fullscreen?: boolean;
    kind?: "drawer";
    modalWidth: string;
  },
) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);

  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Preview";
  modal.style.setProperty("--wa-transition-normal", "150ms");
  modal.style.setProperty("--openclaw-modal-width", options.modalWidth);
  modal.classList.toggle("fullscreen", options.fullscreen === true);
  modal.classList.toggle("drawer", options.kind !== undefined);
  const content = document.createElement("div");
  content.style.cssText = "width: 100%; height: 80px;";
  modal.append(content);
  document.body.append(modal);
  return await resolveRenderedDialog(modal);
}

describe.runIf(browserMode)("file preview modal responsive layout", () => {
  it.each([320, 375, 390, 640])(
    "keeps source and copy visible at a %dpx viewport",
    async (width) => {
      const { preview, dialog } = await mountPreview(width);
      const list = preview.shadowRoot?.querySelector<HTMLElement>(".list");
      const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
      const copy = preview.shadowRoot?.querySelector<HTMLButtonElement>(".chat-copy-btn");
      const search = preview.shadowRoot?.querySelector<HTMLInputElement>(".search");
      const source = preview.shadowRoot?.querySelector<HTMLElement>(".code-chunk");
      const activeItem = preview.shadowRoot?.querySelector<HTMLElement>(".item.is-active");
      const title = preview.shadowRoot?.querySelector<HTMLElement>(".title");
      expect(list).toBeInstanceOf(HTMLElement);
      expect(detail).toBeInstanceOf(HTMLElement);
      expect(copy).toBeInstanceOf(HTMLButtonElement);
      expect(search).toBeInstanceOf(HTMLInputElement);
      expect(source).toBeInstanceOf(HTMLElement);
      expect(activeItem).toBeInstanceOf(HTMLElement);
      expect(title).toBeInstanceOf(HTMLElement);

      const dialogBounds = dialog.getBoundingClientRect();
      const listBounds = list!.getBoundingClientRect();
      const detailBounds = detail!.getBoundingClientRect();
      const copyBounds = copy!.getBoundingClientRect();
      const searchBounds = search!.getBoundingClientRect();
      const sourceBounds = source!.getBoundingClientRect();
      const activeItemBounds = activeItem!.getBoundingClientRect();
      const titleBounds = title!.getBoundingClientRect();
      const sourceTextRange = document.createRange();
      sourceTextRange.selectNodeContents(source!);
      const sourceTextBounds = sourceTextRange.getBoundingClientRect();

      expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
      expect(dialogBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(dialogBounds.top).toBeGreaterThanOrEqual(0);
      expect(dialogBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(detailBounds.top).toBeGreaterThanOrEqual(listBounds.bottom - 1);
      expect(detailBounds.width).toBeGreaterThan(200);
      expect(copyBounds.top).toBeGreaterThanOrEqual(0);
      expect(copyBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(copyBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(copyBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(searchBounds.width).toBeGreaterThan(80);
      expect(searchBounds.left).toBeGreaterThanOrEqual(0);
      expect(searchBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(searchBounds.top).toBeGreaterThanOrEqual(0);
      expect(searchBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(activeItemBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(activeItemBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(titleBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(titleBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(title?.textContent).toBe(initialFilePath);
      expect(sourceBounds.width).toBeGreaterThan(100);
      expect(sourceBounds.height).toBeGreaterThan(0);
      expect(sourceBounds.top).toBeGreaterThanOrEqual(0);
      expect(sourceBounds.top).toBeLessThan(window.innerHeight);
      expect(sourceTextBounds.width).toBeGreaterThan(0);
      expect(sourceTextBounds.height).toBeGreaterThan(0);
      expect(sourceTextBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(sourceTextBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(sourceTextBounds.top).toBeGreaterThanOrEqual(0);
      expect(sourceTextBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(source?.textContent).toContain("Review the complete support-file contents.");

      const selected = vi.fn();
      preview.addEventListener("file-preview-select", selected);
      search?.focus();
      const { userEvent } = await import("vitest/browser");
      await userEvent.keyboard("{ArrowDown}");
      expect(selected).toHaveBeenCalledOnce();
      expect(selected.mock.calls[0]?.[0].detail).toBe("filters/auto-senders.txt");
    },
  );

  it.each([375, 640])(
    "keeps an empty non-text preview reachable at a %dpx viewport",
    async (width) => {
      const { preview, dialog } = await mountPreview(width, "assets/empty-preview.png");
      const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
      const title = preview.shadowRoot?.querySelector<HTMLElement>(".title");
      const kind = preview.shadowRoot?.querySelector<HTMLElement>(".chip.accent");
      const detailBody = preview.shadowRoot?.querySelector<HTMLElement>(".detail-body");
      expect(detail).toBeInstanceOf(HTMLElement);
      expect(title?.textContent).toBe("assets/empty-preview.png");
      expect(kind?.textContent).toBe("PNG");
      expect(detailBody).toBeInstanceOf(HTMLElement);
      expect(preview.shadowRoot?.querySelector(".chat-copy-btn")).toBeNull();
      expect(preview.shadowRoot?.querySelector(".code-chunk")?.textContent).toBe("");

      const dialogBounds = dialog.getBoundingClientRect();
      const detailBounds = detail!.getBoundingClientRect();
      const detailBodyBounds = detailBody!.getBoundingClientRect();
      expect(detailBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(detailBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(detailBodyBounds.top).toBeGreaterThanOrEqual(0);
      expect(detailBodyBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    },
  );

  it("preserves the desktop side-by-side file layout", async () => {
    const { preview, dialog } = await mountPreview(1280);
    const list = preview.shadowRoot?.querySelector<HTMLElement>(".list");
    const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
    expect(list).toBeInstanceOf(HTMLElement);
    expect(detail).toBeInstanceOf(HTMLElement);

    const listBounds = list!.getBoundingClientRect();
    const detailBounds = detail!.getBoundingClientRect();
    expect(listBounds.width).toBeCloseTo(360, 0);
    expect(detailBounds.left).toBeGreaterThanOrEqual(listBounds.right - 1);
    expect(detailBounds.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right + 1);
  });

  it.each([1280, 390])("expands fullscreen previews at a %dpx viewport", async (width) => {
    const dialog = await mountModal(width, {
      fullscreen: true,
      modalWidth: "min(1040px, calc(100vw - 32px))",
    });

    expect(dialog.getBoundingClientRect().width).toBeGreaterThanOrEqual(width - 21);
  });

  it("preserves narrower owner-defined modal widths on phones", async () => {
    const dialog = await mountModal(390, { modalWidth: "200px" });

    expect(dialog.getBoundingClientRect().width).toBeCloseTo(200, 0);
  });

  it.each([
    { viewport: 390, expectedWidth: 390 },
    { viewport: 1280, expectedWidth: 460 },
  ])("keeps workboard drawers edge-to-edge on phones", async ({ viewport, expectedWidth }) => {
    const dialog = await mountModal(viewport, {
      kind: "drawer",
      modalWidth: "min(460px, 100vw)",
    });

    expect(dialog.getBoundingClientRect().width).toBeCloseTo(expectedWidth, 0);
  });
  it("slides workboard drawers in from the owned edge", async () => {
    const dialog = await mountModal(1280, {
      kind: "drawer",
      modalWidth: "min(460px, 100vw)",
    });
    const style = getComputedStyle(dialog);

    expect(style.animationName).toBe("openclaw-drawer-in");
    expect(style.animationDuration).toBe("0.2s");
  });
});

describe.runIf(browserMode)("large file preview interactions", () => {
  const contents = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n");
  const largeFiles = [
    { path: "large-a.txt", size: "50 KB", contents },
    { path: "large-b.txt", size: "50 KB", contents },
  ];

  it("offers keyboard access to searchable and selectable full contents", async () => {
    const { page, userEvent } = await import("vitest/browser");
    const { preview } = await mountPreview(1280, "large-a.txt", largeFiles);
    const root = preview.shadowRoot!;
    expect(root.querySelectorAll(".code-line").length).toBeLessThan(200);
    const toggle = page.getByRole("button", { name: "Show full content", exact: true });
    await expect.element(toggle).toBeVisible();
    toggle.element().focus();
    await userEvent.keyboard("{Enter}");
    const full = root.querySelector<HTMLElement>(".code-full")!;
    expect(full).not.toBeNull();
    expect(full.textContent).toBe(contents);
    expect(toggle.element().getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".code-vscroll")).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(full);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(contents);
    selection.removeAllRanges();
    const nativeFind = (window as Window & { find: (text: string) => boolean }).find;
    expect(nativeFind.call(window, "line 4999")).toBe(true);
    selection.removeAllRanges();
    preview.query = "large-a";
    await preview.updateComplete;
    expect(root.querySelector(".code-full")?.textContent).toBe(contents);
    await page.getByRole("button", { name: "Show full content", exact: true }).click();
    await expect.poll(() => root.querySelectorAll(".code-line").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".code-line").length).toBeLessThan(200);
    expect(root.querySelector<HTMLElement>(".detail-body")!.scrollTop).toBe(0);
    await page.getByRole("button", { name: "Show full content", exact: true }).click();
    preview.query = "";
    preview.activePath = "large-b.txt";
    await preview.updateComplete;
    expect(root.querySelector(".code-full")).toBeNull();
    expect(root.querySelectorAll(".code-line").length).toBeGreaterThan(0);
    await toggle.click();
    expect(root.querySelector(".code-full")).not.toBeNull();
    preview.remove();
    document.body.append(preview);
    await preview.updateComplete;
    const owner = root.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
    await resolveRenderedDialog(owner);
    expect(root.querySelector(".code-full")).toBeNull();
    expect(toggle.element().getAttribute("aria-pressed")).toBe("false");
  });

  it.each([320, 390])("keeps large-file controls and scrolling usable at %dpx", async (width) => {
    const { page } = await import("vitest/browser");
    const { preview, dialog } = await mountPreview(width, "large-a.txt", largeFiles);
    const root = preview.shadowRoot!;
    const toggle = page.getByRole("button", { name: "Show full content", exact: true });
    const copy = root.querySelector<HTMLButtonElement>(".chat-copy-btn")!;
    const body = root.querySelector<HTMLElement>(".detail-body")!;
    for (const control of [toggle.element(), copy]) {
      const bounds = control.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(dialog.getBoundingClientRect().left);
      expect(bounds.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right);
    }
    expect(body.clientHeight).toBeGreaterThan(0);
    await toggle.click();
    expect(body.clientHeight).toBeGreaterThan(0);
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
  });

  it("tabs into the named scrollport and reaches later lines with the keyboard", async () => {
    const { page, userEvent } = await import("vitest/browser");
    const { preview } = await mountPreview(1280, "large-a.txt", largeFiles);
    const body = preview.shadowRoot!.querySelector<HTMLElement>(".detail-body")!;
    preview.shadowRoot!.querySelector<HTMLButtonElement>(".chat-copy-btn")!.focus();
    await userEvent.keyboard("{Tab}");
    expect(preview.shadowRoot!.activeElement).toBe(body);
    await expect
      .element(page.getByRole("region", { name: "large-a.txt", exact: true }))
      .toBeVisible();
    const selected = vi.fn();
    preview.addEventListener("file-preview-select", selected);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => body.scrollTop).toBeGreaterThan(0);
    expect(selected).not.toHaveBeenCalled();
    await userEvent.keyboard("{PageDown}");
    await expect.poll(() => body.scrollTop).toBeGreaterThan(0);
    await userEvent.keyboard("{Control>}{End}{/Control}");
    await expect
      .poll(
        () =>
          [...preview.shadowRoot!.querySelectorAll<HTMLElement>(".code-line")].at(-1)?.dataset.line,
      )
      .toBe("5000");
    await userEvent.keyboard("{Control>}{Home}{/Control}");
    await expect.poll(() => body.scrollTop).toBe(0);
  });

  it.each(["filter", "same-content file", "reconnect"])(
    "resets the rendered window after %s changes",
    async (change) => {
      const { preview } = await mountPreview(1280, "large-a.txt", largeFiles);
      const body = preview.shadowRoot!.querySelector<HTMLElement>(".detail-body")!;
      const rows = () => [...preview.shadowRoot!.querySelectorAll<HTMLElement>(".code-line")];
      await expect.poll(() => rows()[0]?.dataset.line, { timeout: 2000 }).toBe("1");
      expect(rows().length).toBeLessThan(200);
      body.scrollTop = 44000;
      await expect.poll(() => Number(rows()[0]?.dataset.line)).toBeGreaterThan(1900);
      expect(rows().length).toBeLessThan(200);
      const visible = rows().find(
        (row) => row.getBoundingClientRect().top >= body.getBoundingClientRect().top,
      );
      expect(visible?.textContent?.trim()).toMatch(/^line 200\d$/);
      expect(rows()[0]?.getBoundingClientRect().height).toBe(22);
      if (change === "filter") {
        preview.query = "large-a";
      } else if (change === "reconnect") {
        preview.remove();
        document.body.append(preview);
        const owner =
          preview.shadowRoot!.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
        await resolveRenderedDialog(owner);
      } else {
        preview.activePath = "large-b.txt";
      }
      await preview.updateComplete;
      await expect.poll(() => body.scrollTop).toBe(0);
      await expect.poll(() => rows()[0]?.dataset.line, { timeout: 2000 }).toBe("1");
      expect(rows()[0]?.textContent?.trim()).toBe("line 1");
      expect(rows()[0]?.getBoundingClientRect().top).toBeLessThan(
        body.getBoundingClientRect().bottom,
      );
      body.scrollTop = body.scrollHeight;
      await expect.poll(() => rows().at(-1)?.dataset.line).toBe("5000");
      expect(rows().length).toBeLessThan(200);
    },
  );

  it("opens an actionable keyboard menu inside the native preview dialog", async () => {
    const { preview } = await mountPreview(1280);
    const { page, userEvent } = await import("vitest/browser");
    const action = vi.fn();
    preview.onFileAction = action;
    const item = preview.shadowRoot!.querySelector<HTMLElement>(".item.is-active")!;
    item.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    const menu = page.getByRole("menu", { name: "Workspace file actions" });
    const first = menu.getByRole("menuitem", { name: "Copy filename", exact: true });
    await expect.element(first).toBeVisible();
    expect(preview.shadowRoot!.activeElement?.textContent).toBe("Copy filename");
    await userEvent.keyboard("{ArrowDown}");
    expect(preview.shadowRoot!.activeElement?.textContent).toBe("Copy file contents");
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
    expect(preview.shadowRoot!.activeElement).toBe(item);
    await userEvent.click(item, { button: "right" });
    await first.click();
    expect(action).toHaveBeenCalledWith("copyFilename", files[0]);
  });
});

const originalLocale = i18n.getLocale();
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(async () => {
  await i18n.setLocale(originalLocale);
});
