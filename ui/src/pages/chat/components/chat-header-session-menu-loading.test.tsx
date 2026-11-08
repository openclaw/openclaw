/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "./chat-header-session-menu.ts";

afterEach(() => vi.doUnmock("./chat-header-session-menu-content.tsx"));

it("defers header entries until opening and retains the trigger, focus intent and rows", async () => {
  // mock-isolation: hold only the optional chunk, keeping the native menu owner real.
  const entered = createDeferred();
  const imported = createDeferred();
  const ready = createDeferred();
  onTestFinished(() => ready.resolve());
  let loads = 0;
  vi.doMock("./chat-header-session-menu-content.tsx", async () => {
    loads++;
    entered.resolve();
    await ready.promise;
    try {
      return await vi.importActual<typeof import("./chat-header-session-menu-content.tsx")>(
        "./chat-header-session-menu-content.tsx",
      );
    } finally {
      imported.resolve();
    }
  });
  const onAction = vi.fn();
  const menu = document.createElement("openclaw-chat-header-session-menu");
  menu.session = { ...menu.session, label: "Synthetic session" };
  menu.onAction = onAction;
  menu.archiveAllowed = true;
  menu.deleteAllowed = true;
  document.body.append(menu);
  onTestFinished(() => menu.remove());
  await menu.updateComplete;
  expect(loads).toBe(0);
  const trigger = menu.readTrigger()!;
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
  );
  await entered.promise;
  const panel = menu.querySelector<HTMLElement>(".chat-header-session-menu__panel")!;
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
  expect(menu.readTrigger()).toBe(trigger);
  expect(menu.querySelector('[data-value="header-session-loading"]')).not.toBeNull();
  expect(loads).toBe(1);
  menu.session = { ...menu.session, pinned: true };
  ready.resolve();
  await imported.promise;
  await waitForSolid(() => {
    expect(menu.querySelector('[data-value="toggle-pin"]')?.textContent).toContain("Unpin");
    expect(document.activeElement?.getAttribute("data-value")).toBe("submenu:advanced");
  });
  const pin = menu.querySelector<HTMLButtonElement>('[data-value="toggle-pin"]')!;
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flush();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  menu.session = { ...menu.session, pinned: false };
  await menu.updateComplete;
  expect(menu.openMenu()).toBe(true);
  await waitForSolid(() => expect(pin.textContent).toContain("Pin session"));
  expect(menu.querySelector('[data-value="toggle-pin"]')).toBe(pin);
  expect(menu.readTrigger()).toBe(trigger);
  expect(loads).toBe(1);
  pin.click();
  expect(onAction).toHaveBeenCalledWith({ kind: "toggle-pin" });
});
