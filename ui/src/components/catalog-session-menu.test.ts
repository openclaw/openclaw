/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./catalog-session-menu-solid.tsx";

const item = (menu: Element, action: string) =>
  menu.querySelector<HTMLButtonElement>(`[data-value="${action}"]`)!;
const panel = (menu: Element) => menu.querySelector<HTMLElement>('[role="menu"]')!;

async function mountMenu(
  props: Partial<HTMLElementTagNameMap["openclaw-catalog-session-menu"]> = {},
) {
  const menu = document.createElement("openclaw-catalog-session-menu");
  Object.assign(menu, props);
  document.body.append(menu);
  await menu.updateComplete;
  return menu;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["terminal", "viewer"] as const)(
  "dispatches %s before closing, including synchronous removal",
  async (action) => {
    const warnings = vi.spyOn(console, "warn");
    let backingState: { open: true } | null = { open: true };
    const order: string[] = [];
    const onClose = vi.fn(() => {
      backingState = null;
      order.push("close");
    });
    const menu = await mountMenu({
      onAction: (selected) => {
        order.push(backingState ? selected : "cleared");
        if (action === "viewer") {
          menu.remove();
        }
      },
      onClose,
    });
    item(menu, action).click();

    await waitForSolid(() => expect(order).toEqual([action, "close"]));
    expect(onClose).toHaveBeenCalledOnce();
    expect(backingState).toBeNull();
    expect(
      warnings.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("[NO_OWNER_EFFECT]"),
      ),
    ).toEqual([]);
  },
);

it("opens and focuses the native menu while keeping unavailable terminal selection disabled", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu({ lastActive: "57d", terminalDisabled: true, onAction });
  const terminal = item(menu, "terminal");
  await waitForSolid(() => expect(document.activeElement).toBe(item(menu, "viewer")));
  expect(panel(menu).matches(":popover-open")).toBe(true);
  expect(
    [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (entry) => entry.dataset.value,
    ),
  ).toEqual(["viewer", "terminal"]);
  expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  expect(terminal).toMatchObject({
    disabled: true,
    title: "Terminal opening is unavailable for this session.",
  });
  terminal.click();
  expect(onAction).not.toHaveBeenCalled();
});

it.each([false, true])("returns focus on Escape (replacement trigger: %s)", async (replace) => {
  const onClose = vi.fn();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const menu = await mountMenu({ trigger, onClose });
  const viewer = item(menu, "viewer");
  await waitForSolid(() => expect(document.activeElement).toBe(viewer));

  let returnTarget = trigger;
  if (replace) {
    returnTarget = document.createElement("button");
    document.body.append(returnTarget);
    trigger.remove();
    menu.trigger = returnTarget;
    await waitForSolid(() => expect(menu.trigger).toBe(returnTarget));
  }
  viewer.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(returnTarget);
  expect(item(menu, "viewer")).toBe(viewer);
  expect(panel(menu).matches(":popover-open")).toBe(false);
});
