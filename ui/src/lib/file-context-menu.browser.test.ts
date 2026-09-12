import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n, t } from "../i18n/index.ts";
import { openFileContextMenu } from "./file-context-menu.ts";

let closeMenu: (() => void) | null = null;
afterEach(() => {
  closeMenu?.();
  closeMenu = null;
  document.body.replaceChildren();
});

function mountTrigger(onAction = vi.fn<() => void | Promise<void>>()) {
  const trigger = document.createElement("button");
  trigger.textContent = "file.txt";
  trigger.style.cssText = "position:fixed;left:100px;top:80px;width:120px;height:32px;border:0";
  const open = (event: Event) => {
    closeMenu = openFileContextMenu({
      event,
      reference: {
        origin: "session",
        sessionKey: "test",
        relativePath: "file.txt",
        name: "file.txt",
      },
      actions: ["preview", "copyFilename", "download"],
      onAction,
    });
  };
  trigger.addEventListener("contextmenu", open);
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "F10" && event.shiftKey) {
      open(event);
    }
  });
  document.body.append(trigger);
  return trigger;
}

const menu = () => page.getByRole("menu", { name: "Workspace file actions" });

describe("file context menu browser interactions", () => {
  it("resolves labels using the active locale when reopening", async () => {
    const trigger = mountTrigger();
    await userEvent.click(trigger, { button: "right" });
    await expect
      .element(page.getByRole("menuitem", { name: "Preview", exact: true }))
      .toBeVisible();
    closeMenu?.();
    await i18n.setLocale("zh-CN");
    expect(t("chat.workspaceFiles.preview")).not.toBe("Preview");
    await userEvent.click(trigger, { button: "right" });
    await expect
      .element(page.getByRole("menuitem", { name: t("chat.workspaceFiles.preview"), exact: true }))
      .toBeVisible();
  });

  it("positions the mouse menu inside viewport edges", async () => {
    await page.viewport(640, 480);
    const trigger = mountTrigger();
    await userEvent.click(trigger, { button: "right", position: { x: 20, y: 10 } });
    let bounds = document.querySelector('[role="menu"]')!.getBoundingClientRect();
    expect(bounds.left).toBe(120);
    expect(bounds.top).toBe(90);
    closeMenu?.();
    trigger.style.left = "610px";
    trigger.style.top = "450px";
    trigger.style.width = "30px";
    trigger.style.height = "30px";
    await userEvent.click(trigger, { button: "right", position: { x: 20, y: 20 } });
    bounds = document.querySelector('[role="menu"]')!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(8);
    expect(bounds.top).toBeGreaterThanOrEqual(8);
    expect(bounds.right).toBeLessThanOrEqual(632);
    expect(bounds.bottom).toBeLessThanOrEqual(472);
  });

  it("navigates and restores focus for keyboard dismissal and activation", async () => {
    const onAction = vi.fn();
    const trigger = mountTrigger(onAction);
    for (const dismissal of ["Escape", "Tab"]) {
      trigger.focus();
      await userEvent.keyboard("{Shift>}{F10}{/Shift}");
      await expect
        .element(menu().getByRole("menuitem", { name: "Preview", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      await expect
        .element(menu().getByRole("menuitem", { name: "Download file", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{ArrowDown}");
      await expect
        .element(menu().getByRole("menuitem", { name: "Preview", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{End}{Home}{ArrowDown}");
      await expect
        .element(menu().getByRole("menuitem", { name: "Copy filename", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard(`{${dismissal}}`);
      expect(document.activeElement).toBe(trigger);
    }
    await userEvent.keyboard("{Shift>}{F10}{/Shift}{Enter}");
    expect(onAction).toHaveBeenCalledWith("preview");
    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus when an obsolete async action finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = mountTrigger(vi.fn(() => pending));
    await userEvent.click(first, { button: "right" });
    await menu().getByRole("menuitem", { name: "Preview", exact: true }).click();
    await userEvent.keyboard("{Escape}");
    const second = mountTrigger();
    // Keep the original trigger connected so stale restoration is observable.
    first.style.left = "300px";
    await userEvent.click(second, { button: "right" });
    finish();
    await pending;
    await expect
      .element(menu().getByRole("menuitem", { name: "Preview", exact: true }))
      .toHaveFocus();
  });
  it("shows a safe error and permits retry when an action fails", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("private fixture detail"))
      .mockResolvedValue(undefined);
    const trigger = mountTrigger(action);
    await userEvent.click(trigger, { button: "right" });
    const preview = menu().getByRole("menuitem", { name: "Preview", exact: true });
    await preview.click();
    await expect
      .element(menu().getByRole("alert"))
      .toHaveTextContent("Action failed. Please try again.");
    expect(document.body.textContent).not.toContain("private fixture detail");
    await preview.click();
    expect(action).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

const originalLocale = i18n.getLocale();
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(async () => {
  await i18n.setLocale(originalLocale);
});
