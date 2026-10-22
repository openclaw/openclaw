/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { i18n } from "../i18n/index.ts";
import { de } from "../i18n/locales/de.ts";
import * as clipboard from "../lib/clipboard.ts";
import "../lib/toast-host.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountNativeLinkMenu } from "./native-link-menu.runtime.ts";
import { settleTooltip, tooltipSurface } from "./tooltip.test-support.ts";

const containers: HTMLElement[] = [];
const text = (element: Element, selector: string) => element.querySelector(selector)?.textContent;
function append<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.createElement(tag);
  document.body.append(element);
  containers.push(element);
  return element;
}
function keydown(target: EventTarget, key: string, code?: string) {
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(async () => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});
async function mountMenu(withTrigger = false) {
  const trigger = withTrigger ? Object.assign(append("a"), { href: "https://example.com" }) : null;
  const container = append("div"),
    menu = document.createElement("openclaw-native-link-menu");
  const calls: string[] = [];
  const onClose = vi.fn(() => calls.push("close"));
  Object.assign(menu, {
    x: 100,
    y: 100,
    trigger,
    onClose,
    onAction: (action: string) => calls.push(action),
  });
  container.append(menu);
  await menu.updateComplete;
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const labels = () => items().map((item) => text(item, ".session-menu__text")?.trim());
  return { menu, trigger, onClose, calls, items, labels, item: items()[0]! };
}

it("renders native actions in order and closes before dispatch", async () => {
  const { item, labels, calls } = await mountMenu();
  await Promise.resolve();
  expect(document.activeElement).toBe(item);
  expect(labels()).toEqual(["Open in Browser Panel", "Open in Default Browser", "Copy Link"]);
  item.click();
  await Promise.resolve();
  expect(calls).toEqual(["close", "inline"]);
});

it.each([
  [true, "Copied!"],
  [false, "Copy failed"],
])("reports clipboard success=%s after the menu closes", async (copied, message) => {
  const pending = Promise.withResolvers<boolean>();
  const copy = vi.spyOn(clipboard, "copyToClipboard").mockReturnValue(pending.promise);
  const host = append("openclaw-toast-host");
  const anchor = Object.assign(append("a"), { href: "https://example.com/report" });
  const menu = mountNativeLinkMenu({
    path: [anchor, document, window],
    anchor,
    url: new URL(anchor.href),
    x: 100,
    y: 100,
    close: (current) => current.remove(),
    openExternal: vi.fn(),
    openInline: vi.fn(),
  })!;
  await menu.updateComplete;
  menu.querySelector<HTMLButtonElement>('[data-value="copy"]')!.click();
  expect(menu.isConnected).toBe(false);
  expect(copy).toHaveBeenCalledExactlyOnceWith(anchor.href);
  expect(host.querySelector('[role="status"]')).toBeNull();

  pending.resolve(copied);
  await waitForSolid(() => {
    expect(host.querySelector('[role="status"]')?.textContent).toContain(message);
  });
});

it("rerenders open actions when the locale changes", async () => {
  const { menu, labels } = await mountMenu();
  const surface = menu.querySelector('[role="menu"]');
  expect(surface).not.toBeNull();
  await i18n.setLocale("de");
  await menu.updateComplete;
  const german = flattenTranslations(de);
  await vi.waitFor(() =>
    expect(surface?.getAttribute("aria-label")).toBe(german.get("nativeLinkMenu.label")),
  );
  expect(labels()).toEqual([
    // English copy falls back until the post-merge locale refresh.
    german.get("nativeLinkMenu.openInline") ?? "Open in Browser Panel",
    german.get("nativeLinkMenu.openExternal"),
    german.get("nativeLinkMenu.copy"),
  ]);
});

it.each([
  ["s", "KeyS", "inline"],
  ["b", "KeyB", "external"],
  ["с", "KeyC", "copy"],
])("dispatches shortcut %s (%s) as %s", async (key, code, action) => {
  const { item, items, calls } = await mountMenu();
  expect(items().map((entry) => text(entry, ".session-menu__shortcut"))).toEqual(["S", "B", "C"]);
  keydown(item, key, code);
  await Promise.resolve();
  expect(calls).toEqual(["close", action]);
});

it("dismisses the tooltip before its menu and restores focus", async () => {
  const { menu, trigger, onClose, item } = await mountMenu(true);
  const tooltip = document.createElement("openclaw-tooltip");
  Object.assign(tooltip, { content: "Link action details", anchor: item });
  menu.append(tooltip);
  await tooltip.updateComplete;
  item.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
  await settleTooltip(tooltip);
  const popup = tooltipSurface(tooltip)!;
  expect(popup.matches(":popover-open")).toBe(true);
  const firstEscape = keydown(item, "Escape");
  expect([popup.matches(":popover-open"), firstEscape.defaultPrevented]).toEqual([false, true]);
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(trigger);
  expect(keydown(item, "Escape").defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);
});

it("returns focus to the trigger before native Tab exit", async () => {
  const { trigger, item } = await mountMenu(true);
  item.focus();
  const event = keydown(item, "Tab");
  expect(document.activeElement).toBe(trigger);
  expect(event.defaultPrevented).toBe(false);
});

it("closes after outside focus without stealing it", async () => {
  const { onClose } = await mountMenu(true);
  const outside = append("button");
  outside.focus();
  await Promise.resolve();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(outside);
});
