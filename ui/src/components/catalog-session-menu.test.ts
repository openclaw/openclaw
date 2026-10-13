/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type CatalogMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type CatalogMenuItem = HTMLElement & { disabled: boolean; updateComplete: Promise<unknown> };

afterEach(() => document.body.replaceChildren());

describe("catalog session menu", () => {
  it("renders an anchored Web Awesome dropdown and focuses the first item", async () => {
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, { lastActive: "57d" });
    document.body.append(menu);
    await menu.updateComplete;
    const dropdown = menu.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const items = [...menu.querySelectorAll<CatalogMenuItem>("wa-dropdown-item")];

    await Promise.resolve();
    expect(dropdown?.open).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(items.map((item) => item.getAttribute("value"))).toEqual(["viewer", "terminal"]);
    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it("dispatches the selected action before synchronous close", async () => {
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

    menu.querySelector<CatalogMenuItem>('wa-dropdown-item[value="terminal"]')?.click();

    expect(onAction).toHaveBeenCalledWith("terminal");
    expect(order).toEqual(["terminal", "close"]);
    expect(backingState).toBeNull();
  });

  it("disables terminal selection with the unavailable reason", async () => {
    const onAction = vi.fn();
    // SAFETY: The imported bridge registers this tag with its declared properties.
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
    Object.assign(menu, { terminalDisabled: true, onAction });
    document.body.append(menu);
    await menu.updateComplete;
    const terminal = menu.querySelector<CatalogMenuItem>('wa-dropdown-item[value="terminal"]');

    expect(terminal?.disabled).toBe(true);
    expect(terminal?.title).toBe("Terminal opening is unavailable for this session.");
    terminal?.click();
    expect(onAction).not.toHaveBeenCalled();
  });
});
