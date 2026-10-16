/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./catalog-session-menu-solid.tsx";
import type { CatalogSessionMenuAction } from "./catalog-session-menu-solid.tsx";

type CatalogMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type CatalogMenuItem = HTMLButtonElement;

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
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

  it.each(["terminal", "original"] as const)(
    "dispatches %s before synchronous close",
    async (action) => {
      const warnings = vi.spyOn(console, "warn");
      let backingState: { open: true } | null = { open: true };
      const order: string[] = [];
      const onAction = vi.fn((selected: CatalogSessionMenuAction) => {
        order.push(backingState ? selected : "cleared");
      });
      // SAFETY: The imported bridge registers this tag with its declared properties.
      const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement;
      Object.assign(menu, {
        onAction,
        canOpenOriginal: true,
        onClose: () => {
          backingState = null;
          order.push("close");
        },
      });
      document.body.append(menu);
      await menu.updateComplete;

      menu.querySelector<CatalogMenuItem>(`[data-value="${action}"]`)?.click();

      await waitForSolid(() => expect(onAction).toHaveBeenCalledWith(action));
      expect(order).toEqual([action, "close"]);
      expect(backingState).toBeNull();
      expect(
        warnings.mock.calls.filter(
          ([message]) => typeof message === "string" && message.includes("[NO_OWNER_EFFECT]"),
        ),
      ).toEqual([]);
    },
  );

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
    menu.remove();
    onClose.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
  it("updates original-link visibility and edge placement on the retained native menu", async () => {
    const menu = document.createElement("openclaw-catalog-session-menu");
    Object.assign(menu, { x: window.innerWidth, y: window.innerHeight });
    document.body.append(menu);
    await menu.updateComplete;
    const trigger = menu.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    const topWithoutOriginal = Number.parseFloat(trigger.style.top);
    expect(menu.querySelector('[data-value="original"]')).toBeNull();
    menu.canOpenOriginal = true;
    await waitForSolid(() => {
      expect(
        [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
          (item) => item.dataset.value,
        ),
      ).toEqual(["viewer", "original", "terminal"]);
      expect(Number.parseFloat(trigger.style.top)).toBeLessThan(topWithoutOriginal);
    });
    expect(Number.parseFloat(trigger.style.left)).toBeGreaterThanOrEqual(8);
    menu.canOpenOriginal = false;
    await waitForSolid(() => {
      expect(menu.querySelector('[data-value="original"]')).toBeNull();
      expect(Number.parseFloat(trigger.style.top)).toBe(topWithoutOriginal);
    });
  });

  it("reactively translates the retained native menu without a caller property change", async () => {
    const menu = document.createElement("openclaw-catalog-session-menu");
    menu.lastActive = "57d";
    document.body.append(menu);
    await menu.updateComplete;
    const info = menu.querySelector(".session-menu__info")!;
    const english = info.textContent;
    await i18n.setLocale("de");
    await waitForSolid(() =>
      expect(info.textContent?.trim()).toBe(t("sessionsView.lastActive", { time: "57d" })),
    );
    expect(info.textContent).not.toBe(english);
  });
});
