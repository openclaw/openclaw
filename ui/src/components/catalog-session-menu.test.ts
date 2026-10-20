/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./catalog-session-menu-solid.tsx";

type CatalogSessionMenuAction = Parameters<
  HTMLElementTagNameMap["openclaw-catalog-session-menu"]["onAction"]
>[0];

async function mountMenu(
  props: Partial<HTMLElementTagNameMap["openclaw-catalog-session-menu"]> = {},
) {
  const menu = document.createElement("openclaw-catalog-session-menu");
  Object.assign(menu, props);
  document.body.append(menu);
  await menu.updateComplete;
  return menu;
}

function escapeMenu(target = document.activeElement) {
  target?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("catalog session menu", () => {
  it("renders an anchored native menu and focuses the first item", async () => {
    const menu = await mountMenu({ lastActive: "57d" });
    const panel = menu.querySelector<HTMLElement>('[role="menu"]');
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

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
    const menu = await mountMenu({
      onAction,
      onClose: () => {
        backingState = null;
        order.push("close");
      },
    });
    menu.querySelector<HTMLButtonElement>('[data-value="terminal"]')?.click();

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
    const menu = await mountMenu({
      onAction: (action: CatalogSessionMenuAction) => {
        order.push(action);
        menu.remove();
      },
      onClose,
    });
    menu.querySelector<HTMLButtonElement>('[data-value="viewer"]')!.click();
    await waitForSolid(() => expect(order).toEqual(["viewer", "close"]));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables terminal selection with the unavailable reason", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({ terminalDisabled: true, onAction });
    const terminal = menu.querySelector<HTMLButtonElement>('[data-value="terminal"]');

    expect(terminal?.disabled).toBe(true);
    expect(terminal?.title).toBe("Terminal opening is unavailable for this session.");
    terminal?.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([false, true])("returns focus on Escape (replacement trigger: %s)", async (replace) => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const menu = await mountMenu({ trigger, onClose });
    await waitForSolid(() =>
      expect(document.activeElement).toBe(menu.querySelector('[data-value="viewer"]')),
    );

    const item = document.activeElement;
    let returnTarget = trigger;
    if (replace) {
      returnTarget = document.createElement("button");
      document.body.append(returnTarget);
      trigger.remove();
      menu.trigger = returnTarget;
      await waitForSolid(() => expect(menu.trigger).toBe(returnTarget));
    }
    escapeMenu(item);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(returnTarget);
    expect(menu.querySelector('[data-value="viewer"]')).toBe(item);
    expect(menu.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(false);
  });
});
