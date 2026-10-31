import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../lib/toast-host.tsx";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { installTitleTooltips } from "./tooltip-title.ts";
import "../styles/base.css";
import "../styles/chat/text.css";

let dispose: () => void;
const filePath = "/Users/example/My Project/src/application.ts";

beforeEach(async () => {
  document.body.innerHTML = `<openclaw-tooltip-provider><main class="chat-text" style="padding:80px 24px">${toSanitizedMarkdownHtml(
    `[application.ts](<${filePath}:42>) and \`src/next.ts\`.`,
    { fileLinks: true },
  )}</main><button id="outside">Outside</button></openclaw-tooltip-provider><openclaw-toast-host></openclaw-toast-host>`;
  dispose = installTitleTooltips(document);
  // The browser retains pointer coordinates when each case replaces the file links.
  await page.getByRole("button", { name: "Outside", exact: true }).hover();
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const anchor = () => document.querySelector<HTMLAnchorElement>("a[data-file-path]")!;
const card = () =>
  document.querySelector<HTMLElement>("openclaw-tooltip[open] .markdown-file-tooltip");
const copyButton = () => page.getByRole("button", { name: "Copy path", exact: true });
const outsideButton = () => page.getByRole("button", { name: "Outside", exact: true });
async function focusFile() {
  anchor().focus();
  await expect.element(copyButton()).toBeVisible();
}
const tooltipOwner = () => copyButton().element().closest("openclaw-tooltip")!;
const waitForReopen = (tooltip: HTMLElementTagNameMap["openclaw-tooltip"]) =>
  new Promise<void>((resolve) => {
    // Closing content can still be visible; completion belongs to this owner.
    tooltip.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
async function reopen(tooltip: HTMLElementTagNameMap["openclaw-tooltip"]) {
  await outsideButton().hover();
  const reopened = waitForReopen(tooltip);
  await page.elementLocator(anchor()).hover();
  await reopened;
  await expect.element(copyButton()).toBeVisible();
}

it("keeps the popup reachable and copies the exact path without opening the file", async () => {
  const copied = Promise.withResolvers<void>();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(copied.promise);
  const open = vi.fn();
  anchor().addEventListener("click", open);
  const outside = document.querySelector<HTMLButtonElement>("#outside")!;
  const handleEscape = vi.fn();
  outside.addEventListener("keydown", handleEscape);
  outside.focus();
  await page.elementLocator(anchor()).hover();
  await expect.element(copyButton()).toBeVisible();
  expect(card()?.textContent?.trim()).toBe(filePath);
  await copyButton().hover();
  await copyButton().click();
  expect(write).toHaveBeenCalledWith(filePath);
  copied.resolve();
  await expect.poll(() => card()?.querySelector('[role="status"]')?.textContent).toBe("Copied!");
  expect(open).not.toHaveBeenCalled();
  expect(card()?.textContent).toContain(filePath);
  expect(document.querySelectorAll("openclaw-tooltip[open]")).toHaveLength(1);
  const tooltip = tooltipOwner();
  outside.focus();
  await page.elementLocator(anchor()).hover();
  await expect.element(copyButton()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(card).toBeNull();
  expect(handleEscape).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(outside);
  await reopen(tooltip);
  await expect.poll(() => card()?.textContent?.trim()).toBe(filePath);
  await page.elementLocator(anchor()).click();
  expect(open).toHaveBeenCalledOnce();
  expect(card()).toBeNull();
});

it.each([undefined, true, false])(
  "preserves keyboard navigation after dismissal or fallback (copied=%s)",
  async (copied) => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    const fallback = vi.spyOn(document, "execCommand").mockReturnValue(copied ?? false);
    anchor().textContent = filePath;
    anchor().removeAttribute("title");
    await focusFile();
    expect(anchor().matches(":hover")).toBe(false);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(copyButton().element());
    await userEvent.keyboard(copied === undefined ? "{Escape}" : "{Enter}");
    if (copied !== undefined) {
      expect(fallback).toHaveBeenCalledWith("copy");
    }
    expect(document.activeElement).toBe(anchor());
    if (copied === false) {
      await expect.element(page.getByRole("status")).toHaveTextContent("Copy failed");
    }
    expect(card()).toBeNull();
    expect(anchor().hasAttribute("title")).toBe(false);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(document.querySelectorAll("a[data-file-path]")[1]);
  },
);

it("does not open on touch-induced focus, including after content loads", async () => {
  const source = anchor();
  source.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" }));
  source.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  source.focus();
  source.click();
  await expect.poll(() => document.querySelector(".markdown-file-tooltip button")).not.toBeNull();
  expect(card()).toBeNull();
  source.blur();
  source.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  source.focus();
  expect(card()).toBeNull();
});

it.each(["Escape", "outside", "reopen"])(
  "cancels delayed clipboard fallback after %s dismissal",
  async (dismissal) => {
    const copied = Promise.withResolvers<void>();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(copied.promise);
    const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
    anchor().focus();
    await copyButton().click();
    const tooltip = tooltipOwner();
    await (dismissal === "outside" ? outsideButton().click() : userEvent.keyboard("{Escape}"));
    await expect.poll(card).toBeNull();
    if (dismissal === "reopen") {
      await reopen(tooltip);
    }
    copied.reject(new Error("Denied"));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(Boolean(card())).toBe(dismissal === "reopen");
  },
);

it.each(["path changes", "link is removed", "file switches"])(
  "retires copy controls and pending feedback when the %s",
  async (change) => {
    const copied = Promise.withResolvers<void>();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(copied.promise);
    const source = anchor();
    await focusFile();
    await copyButton().click();
    if (change === "path changes") {
      source.dataset.filePath = "/workspace/replacement.ts";
    } else if (change === "link is removed") {
      source.remove();
    } else {
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(document.querySelectorAll("a[data-file-path]")[1]);
    }
    copied.resolve();
    if (change === "file switches") {
      await expect.element(copyButton()).toBeVisible();
      expect(card()?.textContent).toContain("src/next.ts");
      expect(card()?.textContent).not.toContain("Copied!");
    } else {
      await expect.poll(card).toBeNull();
      expect(document.querySelector(".markdown-file-tooltip")).toBeNull();
      expect(source.title).toBe(`${filePath}:42`);
    }
  },
);
