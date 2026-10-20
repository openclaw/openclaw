import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import "../styles.css";
import { i18n } from "../i18n/index.ts";
import { waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showToast, type ToastOptions } from "./toast.ts";
import "./toast-host.ts";

const rect = (element: Element) => element.getBoundingClientRect();
async function useViewport(width: number, height = 844) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}
function makeAnchor(width: number, left = 0) {
  const anchor = document.body.appendChild(document.createElement("div"));
  anchor.style.cssText = `position: fixed; top: 100px; left: ${left}px; width: ${width}px; height: 100px`;
  return anchor;
}
function linkedMessage(label: string, before = "Connection lost. ".repeat(12)) {
  const message = document.createDocumentFragment();
  const link = document.createElement("a");
  link.href = `#${label}`;
  link.textContent = label;
  message.append(before, link);
  return { message, link };
}
async function renderToast(
  options: Partial<ToastOptions> = {},
  host = document.createElement("openclaw-toast-host"),
) {
  if (!host.isConnected) {
    document.body.append(host);
  }
  await host.updateComplete;
  showToast({
    message: "Session archived",
    actionLabel: "Undo",
    onAction: () => undefined,
    durationMs: 60_000,
    ...options,
  });
  await vi.dynamicImportSettled();
  const part = (name = "") =>
    host.querySelector<HTMLElement>(`.app-toast${name ? `__${name}` : ""}`)!;
  await waitForSolid(() => expect(part()).not.toBeNull());
  const toast = part(),
    message = part("message"),
    action = part("action"),
    dismiss = part("dismiss");
  await Promise.all(toast.getAnimations().map((animation) => animation.finished));
  return { host, toast, message, action, dismiss };
}
type ToastFixture = Awaited<ReturnType<typeof renderToast>>;
async function expectFocusPreserved({ host }: ToastFixture, link: HTMLAnchorElement) {
  link.focus();
  expect(document.activeElement).toBe(link);
  host.toast = { ...host.toast! };
  await waitForSolid(() => expect(host.querySelector(".app-toast__message a")).toBe(link));
  expect(document.activeElement).toBe(link);
}

describe.skipIf(navigator.userAgent.toLowerCase().includes("jsdom"))("toast browser layout", () => {
  let rootStyle: string | null;
  const root = document.documentElement;
  beforeEach(async () => {
    rootStyle = root.getAttribute("style");
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    if (rootStyle === null) {
      root.removeAttribute("style");
    } else {
      root.setAttribute("style", rootStyle);
    }
  });

  it("shows the selected agent avatar at notification size without crowding the action", async () => {
    await useViewport(390);
    const onAction = vi.fn();
    const { host } = await renderToast({ onAction, actionLabel: "Open session" });
    const avatar = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    showToast({ ...host.toast!, avatar: { id: "gardener", name: "Garden keeper", avatar } });
    const avatarImage = () => host.querySelector<HTMLImageElement>(".app-toast__avatar img")!;
    await waitForSolid(() => expect(avatarImage().naturalWidth).toBeGreaterThan(0));
    expect(avatarImage().getAttribute("src")).toBe(avatar);
    expect(rect(avatarImage())).toMatchObject({ width: 28, height: 28 });
    const action = host.querySelector("button")!;
    expect(rect(action).right).toBeLessThanOrEqual(390);
    action.click();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("keeps a toast usable inside a native modal and returns it to the shell on dismissal", async () => {
    const shell = document.body.appendChild(document.createElement("div"));
    shell.className = "shell";
    const host = shell.appendChild(document.createElement("openclaw-toast-host"));
    const controller = new AbortController();
    const confirmation = showConfirmDialog({ message: "Keep?", signal: controller.signal });
    try {
      const { modal, dialog } = await waitForRenderedModalDialog(document.body);
      const onAction = vi.fn();
      const { action } = await renderToast({ message: "Saved", onAction }, host);
      expect(host.parentElement).toBe(modal.getOverlayContainer());
      action.focus();
      expect(document.activeElement).toBe(action);
      expect(dialog.open).toBe(true);
      const { left, top, width, height } = rect(action);
      expect(document.elementFromPoint(left + width / 2, top + height / 2)).toBe(action);
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await confirmation;
      await host.updateComplete;
      expect(host.parentElement).toBe(shell);
      expect(host.textContent).toContain("Saved");
      host.querySelector<HTMLElement>(".app-toast__action")!.click();
      expect(onAction).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await confirmation;
    }
  });

  it.each([
    ["top", 390],
    ["top", 1280],
    ["bottom", 390],
    ["bottom", 1280],
  ] as const)("keeps %s feedback usable at width %i", async (placement, width) => {
    await useViewport(width);
    root.style.setProperty("--safe-area-bottom", "24px");
    const { toast, action, dismiss } = await renderToast({ placement });
    const bounds = rect(toast);
    expect(rect(dismiss).height).toBe(width === 390 ? 44 : 32);
    if (placement === "bottom") {
      expect(bounds).toMatchObject({
        bottom: expect.closeTo(800, 0),
        right: expect.closeTo(width - (width === 390 ? 12 : 20), 0),
      });
      root.style.setProperty("--shell-viewport-height", "600px");
      root.style.setProperty("--shell-safe-area-bottom", "0px");
      expect(rect(toast).bottom).toBeCloseTo(580, 0);
      root.style.removeProperty("--shell-viewport-height");
      root.style.removeProperty("--shell-safe-area-bottom");
      expect(rect(toast).bottom).toBeCloseTo(800, 0);
    } else {
      expect(bounds.top).toBeCloseTo(20, 0);
      if (width === 390) {
        expect(bounds).toMatchObject({
          left: expect.closeTo(12, 0),
          right: expect.closeTo(378, 0),
        });
        expect(rect(action).left).toBeGreaterThan(bounds.left + bounds.width * 0.6);
        expect(rect(dismiss).right).toBeLessThanOrEqual(bounds.right - 7);
        expect(rect(action).height).toBeGreaterThanOrEqual(44);
      } else {
        expect(bounds.width).toBeLessThan(320);
        expect(bounds.height).toBeLessThan(60);
      }
    }
  });

  it("keeps anchored notices independent of bottom placement", async () => {
    const { toast } = await renderToast({ anchor: makeAnchor(350, 20), placement: "bottom" });
    expect(toast.classList.contains("app-toast--bottom")).toBe(false);
    expect(getComputedStyle(toast).top).toBe("100px");
  });

  it("keeps oversized errors scrollable with actions inside a short phone viewport", async () => {
    await useViewport(320, 400);
    for (const placement of ["top", "bottom"] as const) {
      const { host, toast, message } = await renderToast({
        placement,
        message: "Lost. ".repeat(1000),
      });
      expect(message.scrollHeight).toBeGreaterThan(message.clientHeight);
      message.scrollTop = message.scrollHeight;
      expect(message.scrollTop).toBeGreaterThan(0);
      for (const element of [toast, ...host.querySelectorAll("button")]) {
        expect(rect(element).top).toBeGreaterThanOrEqual(0);
        expect(rect(element).bottom).toBeLessThanOrEqual(400);
      }
      host.remove();
    }
  });

  it.each([1280, 390, 320])("keeps rich feedback readable at width %i", async (width) => {
    await useViewport(width);
    for (const placement of ["top", "bottom", "anchored"] as const) {
      const anchor = makeAnchor(width);
      const recovery = linkedMessage("Settings");
      const fixture = await renderToast({
        message: recovery.message,
        actionLabel: "Discard unsaved changes and reload",
        ...(placement === "anchored" ? { anchor } : { placement }),
      });
      const { host, toast, message, action, dismiss } = fixture;
      host.style.setProperty("--control-ui-text-scale", "1.3");
      expect(rect(toast).left).toBeGreaterThanOrEqual(0);
      expect(rect(toast).right).toBeLessThanOrEqual(width);
      expect(action.clientHeight).toBeGreaterThanOrEqual(action.scrollHeight);
      if (message.scrollHeight > message.clientHeight) {
        message.scrollTop = message.scrollHeight;
        expect(message.scrollTop).toBeGreaterThan(0);
      }
      for (const element of [message, action]) {
        expect(element.clientWidth).toBeGreaterThanOrEqual(element.scrollWidth);
        expect(rect(element).width).toBeGreaterThan(0);
      }
      const textBox = rect(message);
      const actionBox = rect(action);
      expect(actionBox.right).toBeLessThanOrEqual(rect(dismiss).left);
      expect(textBox.right <= actionBox.left || textBox.bottom <= actionBox.top).toBe(true);
      expect(message.querySelector("a")).toBe(recovery.link);
      await expectFocusPreserved(fixture, recovery.link);
      expect(actionBox.height).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
      const replacement = linkedMessage("Sidebar", "Hidden. ");
      showToast({ ...host.toast!, message: replacement.message });
      await waitForSolid(() => expect(replacement.link.isConnected).toBe(true));
      expect(recovery.link.isConnected).toBe(false);
      expect(message.textContent).toBe("Hidden. Sidebar");
      await expectFocusPreserved(fixture, replacement.link);
      host.remove();
      anchor.remove();
    }
  });
});
