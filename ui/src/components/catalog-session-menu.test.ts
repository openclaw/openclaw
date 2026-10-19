/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./catalog-session-menu-solid.tsx";

type CatalogSessionMenuAction = Parameters<
  HTMLElementTagNameMap["openclaw-catalog-session-menu"]["onAction"]
>[0];

type CatalogMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type CatalogMenuItem = HTMLButtonElement;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("catalog session menu", () => {
  it("renders an anchored native menu and focuses the first item", async () => {
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, { lastActive: "57d" });
    document.body.append(menu);
    await menu.updateComplete;
    const panel = menu.querySelector<HTMLElement>('[role="menu"]');
    const items = [...menu.querySelectorAll<CatalogMenuItem>('[role="menuitem"]')];

    await waitForSolid(() => expect(document.activeElement).toBe(items[0]));
    expect(panel?.matches(":popover-open")).toBe(true);
    expect(items.map((item) => item.dataset.value)).toEqual(["viewer", "terminal"]);
    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it("dispatches the selected action before synchronous close", async () => {
    const warnings = vi.spyOn(console, "warn");
    let backingState: { open: true } | null = { open: true };
    const order: string[] = [];
    const onAction = vi.fn((action: CatalogSessionMenuAction) => {
      order.push(backingState ? action : "cleared");
    });
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, {
      onAction,
      onClose: () => {
        backingState = null;
        order.push("close");
      },
    });
    document.body.append(menu);
    await menu.updateComplete;

    menu.querySelector<CatalogMenuItem>('[data-value="terminal"]')?.click();

    await waitForSolid(() => expect(onAction).toHaveBeenCalledWith("terminal"));
    expect(order).toEqual(["terminal", "close"]);
    expect(backingState).toBeNull();
    expect(
      warnings.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("[NO_OWNER_EFFECT]"),
      ),
    ).toEqual([]);
  });

  it("closes once after an action synchronously removes the menu", async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, {
      onAction: (action: CatalogSessionMenuAction) => {
        order.push(action);
        menu.remove();
      },
      onClose,
    });
    document.body.append(menu);
    await menu.updateComplete;

    menu.querySelector<CatalogMenuItem>('[data-value="viewer"]')!.click();
    await waitForSolid(() => expect(order).toEqual(["viewer", "close"]));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables terminal selection with the unavailable reason", async () => {
    const onAction = vi.fn();
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, { terminalDisabled: true, onAction });
    document.body.append(menu);
    await menu.updateComplete;
    const terminal = menu.querySelector<CatalogMenuItem>('[data-value="terminal"]');

    expect(terminal?.disabled).toBe(true);
    expect(terminal?.title).toBe("Terminal opening is unavailable for this session.");
    terminal?.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("returns keyboard focus to the caller's trigger when Escape closes the menu", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const menu = document.createElement("openclaw-catalog-session-menu");
    Object.assign(menu, { trigger, onClose });
    document.body.append(menu);
    await waitForSolid(() =>
      expect(document.activeElement).toBe(menu.querySelector('[data-value="viewer"]')),
    );

    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
    expect(menu.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(false);
  });

  it("returns focus to a replacement trigger without remounting the open menu", async () => {
    const original = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(original, replacement);
    original.focus();
    const menu = document.createElement("openclaw-catalog-session-menu");
    menu.trigger = original;
    document.body.append(menu);
    await waitForSolid(() =>
      expect(document.activeElement).toBe(menu.querySelector('[data-value="viewer"]')),
    );
    const item = document.activeElement;
    original.remove();
    menu.trigger = replacement;
    await waitForSolid(() => expect(menu.trigger).toBe(replacement));

    item?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(replacement);
    expect(menu.querySelector('[data-value="viewer"]')).toBe(item);
    expect(menu.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(false);
  });
});
