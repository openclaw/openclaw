import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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

describe("file path tooltip", () => {
  it("keeps the popup reachable and copies the exact path without opening the file", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const open = vi.fn();
    anchor().addEventListener("click", open);
    await page.elementLocator(anchor()).hover();
    await expect.element(copyButton()).toBeVisible();
    expect(card()?.textContent?.trim()).toBe(filePath);
    await copyButton().hover();
    await Promise.all([
      expect.element(page.getByRole("status")).toHaveTextContent("Copied!"),
      copyButton().click(),
    ]);
    expect(write).toHaveBeenCalledWith(filePath);
    expect(open).not.toHaveBeenCalled();
    expect(card()?.textContent).toContain(filePath);
    expect(document.querySelectorAll("openclaw-tooltip[open]")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await page.elementLocator(anchor()).hover();
    await expect.element(copyButton()).toBeVisible();
    expect(card()?.textContent).not.toContain("Copied!");
    await page.elementLocator(anchor()).click();
    expect(open).toHaveBeenCalledOnce();
    expect(card()).toBeNull();
  });

  it("supports Tab to copy, Escape back to the link, and onward keyboard navigation", async () => {
    anchor().focus();
    await expect.element(copyButton()).toBeVisible();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(copyButton().element());
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(anchor());
    expect(card()).toBeNull();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(document.querySelectorAll("a[data-file-path]")[1]);
  });

  it.each([true, false])(
    "returns keyboard focus after clipboard fallback (copied=%s)",
    async (copied) => {
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(copied);
      anchor().focus();
      await expect.element(copyButton()).toBeVisible();
      expect(anchor().matches(":hover"), "keyboard fallback must start without pointer hover").toBe(
        false,
      );
      await userEvent.keyboard("{Tab}{Enter}");
      expect(fallback).toHaveBeenCalledWith("copy");
      expect(document.activeElement).toBe(anchor());
      if (!copied) {
        await expect.element(page.getByRole("status")).toHaveTextContent("Copy failed");
      }
      expect(card()).toBeNull();
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
      let reject!: (error: Error) => void;
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      );
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      anchor().focus();
      await copyButton().click();
      if (dismissal === "outside") {
        await page.getByRole("button", { name: "Outside", exact: true }).click();
      } else {
        await userEvent.keyboard("{Escape}");
      }
      if (dismissal === "reopen") {
        await page.elementLocator(anchor()).hover();
        await expect.element(copyButton()).toBeVisible();
      }
      reject(new Error("Denied"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(fallback).not.toHaveBeenCalled();
      expect(Boolean(card())).toBe(dismissal === "reopen");
    },
  );

  it.each(["path changes", "link is removed"])(
    "retires copy controls when the %s",
    async (change) => {
      const source = anchor();
      source.focus();
      await expect.element(copyButton()).toBeVisible();
      if (change === "path changes") {
        source.dataset.filePath = "/workspace/replacement.ts";
      } else {
        source.remove();
      }
      await expect.poll(card).toBeNull();
      expect(document.querySelector(".markdown-file-tooltip")).toBeNull();
      expect(source.title).toBe(`${filePath}:42`);
    },
  );

  it("ignores late clipboard feedback after switching to another file", async () => {
    let finish!: () => void;
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    anchor().focus();
    await copyButton().click();
    const next = document.querySelectorAll<HTMLAnchorElement>("a[data-file-path]")[1];
    assert(next, "Expected the second file link in the fixture");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(next);
    finish();
    await expect.element(copyButton()).toBeVisible();
    expect(card()?.textContent).toContain("src/next.ts");
    expect(card()?.textContent).not.toContain("Copied!");
  });

  it("also offers copy when the link label already contains the full path", async () => {
    anchor().textContent = filePath;
    anchor().removeAttribute("title");
    anchor().focus();
    await expect.element(copyButton()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(anchor().hasAttribute("title")).toBe(false);
  });

  it("uses shared tooltip Escape dismissal without moving unrelated focus", async () => {
    const outside = document.querySelector<HTMLButtonElement>("#outside")!;
    const handleEscape = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    outside.addEventListener("keydown", handleEscape);
    outside.focus();
    await page.elementLocator(anchor()).hover();
    await expect.element(copyButton()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(handleEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    expect(card()).toBeNull();
  });
});
