import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import "../styles.css";
import { i18n } from "../i18n/index.ts";
import { waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showToast, type ToastOptions } from "./toast.ts";
import "./toast-host.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const part = (host: HTMLElement, name = "") =>
  host.querySelector<HTMLElement>(`.app-toast${name ? `__${name}` : ""}`)!;
const rect = (host: HTMLElement, name = "") => part(host, name).getBoundingClientRect();
const finishAnimations = (element: HTMLElement) =>
  Promise.all(element.getAnimations().map((animation) => animation.finished));

function makeAnchor(width: number, left = 0) {
  const anchor = document.createElement("div");
  anchor.style.cssText = `position: fixed; top: 100px; left: ${left}px; width: ${width}px; height: 100px`;
  document.body.append(anchor);
  return anchor;
}

function linkedMessage(href: string, label: string, before: string, after = "") {
  const message = document.createDocumentFragment();
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  message.append(before, link, after);
  return { message, link };
}

async function expectFocusPreserved(
  host: HTMLElementTagNameMap["openclaw-toast-host"],
  link: HTMLAnchorElement,
) {
  link.focus();
  expect(document.activeElement).toBe(link);
  host.toast = { ...host.toast! };
  await waitForSolid(() => expect(part(host, "message").querySelector("a")).toBe(link));
  expect(document.activeElement).toBe(link);
}

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function showArchiveToast(
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
  await waitForSolid(() => expect(host.querySelector(".app-toast")).not.toBeNull());
  return host;
}

describe.skipIf(!hasBrowserLayout)("toast browser layout", () => {
  it("shows the selected agent avatar at notification size without crowding the action", async () => {
    await useViewport(390, 844);
    const onAction = vi.fn();
    const options = { message: "Garden plan: Done", actionLabel: "Open session", onAction };
    const host = await showArchiveToast(options);
    const avatar =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#ff9138"/><circle cx="38" cy="40" r="5"/><circle cx="62" cy="40" r="5"/><path d="M40 62 Q50 72 60 62" fill="none" stroke="#000" stroke-width="4"/></svg>',
      );
    showToast({
      ...options,
      durationMs: 60_000,
      avatar: { id: "gardener", name: "Garden keeper", avatar },
    });
    const avatarImage = () => part(host, "avatar").querySelector("img")!;
    await waitForSolid(() => expect(avatarImage().naturalWidth).toBeGreaterThan(0));
    const image = avatarImage();
    expect(image.getAttribute("src")).toBe(avatar);
    expect(image.getBoundingClientRect()).toMatchObject({ width: 28, height: 28 });
    const action = part(host, "action");
    expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    action.click();
    expect(onAction).toHaveBeenCalledOnce();
  });

  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => document.body.replaceChildren());

  it("keeps a toast usable inside a native modal and returns it to the shell on dismissal", async () => {
    const shell = document.createElement("div");
    shell.className = "shell";
    const host = document.createElement("openclaw-toast-host");
    shell.append(host);
    document.body.append(shell);
    const controller = new AbortController();
    const confirmation = showConfirmDialog({
      message: "Keep synthetic changes?",
      signal: controller.signal,
    });
    try {
      const { modal, dialog } = await waitForRenderedModalDialog(document.body);
      const action = vi.fn();
      await showArchiveToast({ message: "Synthetic change saved", onAction: action }, host);
      expect(host.parentElement).toBe(modal.getOverlayContainer());
      const undo = part(host, "action");
      undo.focus();
      expect(document.activeElement).toBe(undo);
      expect(dialog.open).toBe(true);
      // Hit testing proves the notice is above the modal rather than behind its backdrop.
      const { left, top, width, height } = undo.getBoundingClientRect();
      expect(document.elementFromPoint(left + width / 2, top + height / 2)).toBe(undo);
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await confirmation;
      await host.updateComplete;
      expect(host.parentElement).toBe(shell);
      expect(host.textContent).toContain("Synthetic change saved");
      part(host, "action").click();
      expect(action).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await confirmation;
    }
  });

  it("keeps mobile actions trailing while the desktop toast stays compact", async () => {
    await useViewport(390, 844);
    const mobileHost = await showArchiveToast();
    const mobileAction = rect(mobileHost, "action");
    const mobileDismiss = rect(mobileHost, "dismiss");
    const mobile = rect(mobileHost);

    expect(mobile.top).toBeCloseTo(20, 0);
    expect(mobile.left).toBeCloseTo(12, 0);
    expect(mobile.right).toBeCloseTo(378, 0);
    expect(mobileAction.left).toBeGreaterThan(mobile.left + mobile.width * 0.6);
    expect(mobileDismiss.right).toBeLessThanOrEqual(mobile.right - 7);
    expect(mobileAction.height).toBeGreaterThanOrEqual(44);
    expect(mobileDismiss.height).toBe(44);

    mobileHost.remove();
    await useViewport(1280, 800);
    const desktopHost = await showArchiveToast();
    const desktopToast = rect(desktopHost);
    expect(desktopToast.top).toBeCloseTo(20, 0);
    expect(desktopToast.width).toBeLessThan(320);
    expect(desktopToast.height).toBeLessThan(60);
    expect(rect(desktopHost, "dismiss").height).toBe(32);
  });
  it("keeps settings feedback at the safe lower edge without moving anchored notices", async () => {
    const root = document.documentElement;
    const previousStyle = root.getAttribute("style");
    // Physical insets belong to the app root, not the toast.
    root.style.setProperty("--safe-area-bottom", "24px");
    try {
      for (const width of [1280, 390]) {
        await useViewport(width, 844);
        const host = await showArchiveToast({ placement: "bottom" });
        const toast = part(host);
        await finishAnimations(toast);
        const bounds = toast.getBoundingClientRect();
        expect(bounds.bottom).toBeCloseTo(800, 0);
        expect(bounds.right).toBeCloseTo(width - (width === 390 ? 12 : 20), 0);
        expect(rect(host, "dismiss").height).toBe(width === 390 ? 44 : 32);
        // The keyboard shortens the canvas and removes the home-bar inset.
        root.style.setProperty("--shell-viewport-height", "600px");
        root.style.setProperty("--shell-safe-area-bottom", "0px");
        expect(toast.getBoundingClientRect().bottom).toBeCloseTo(580, 0);
        root.style.removeProperty("--shell-viewport-height");
        root.style.removeProperty("--shell-safe-area-bottom");
        expect(toast.getBoundingClientRect().bottom).toBeCloseTo(800, 0);
        host.remove();
      }

      const anchor = makeAnchor(350, 20);
      const host = await showArchiveToast({ anchor, placement: "bottom" });
      const toast = part(host);
      expect(toast.classList.contains("app-toast--bottom")).toBe(false);
      expect(getComputedStyle(toast).top).toBe("100px");
    } finally {
      if (previousStyle === null) {
        root.removeAttribute("style");
      } else {
        root.setAttribute("style", previousStyle);
      }
    }
  });

  it("keeps oversized errors scrollable with actions inside a short phone viewport", async () => {
    await useViewport(320, 400);
    for (const placement of ["top", "bottom"] as const) {
      const host = await showArchiveToast({
        placement,
        message: "The connection was interrupted. Please check your settings. ".repeat(100),
      });
      const toast = part(host);
      await finishAnimations(toast);
      const message = part(host, "message");
      expect(message.scrollHeight).toBeGreaterThan(message.clientHeight);
      message.scrollTop = message.scrollHeight;
      expect(message.scrollTop).toBeGreaterThan(0);
      for (const element of [toast, ...host.querySelectorAll("button")]) {
        const bounds = element.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(400);
      }
      host.remove();
    }
  });

  it("keeps recovery links and long actions readable across placements and text sizes", async () => {
    for (const width of [1280, 390, 320]) {
      await useViewport(width, 844);
      for (const placement of ["top", "bottom", "anchored"] as const) {
        const anchor = makeAnchor(width);
        const recovery = linkedMessage(
          "#settings",
          "Gateway settings",
          "Your changes could not be saved because the connection was interrupted. Keep this tab open, check ",
          ", and try again when the connection is restored.",
        );
        const host = await showArchiveToast({
          message: recovery.message,
          actionLabel: "Discard unsaved changes and reload",
          ...(placement === "anchored" ? { anchor } : { placement }),
        });
        host.style.setProperty("--control-ui-text-scale", "1.3");
        const toast = part(host);
        await finishAnimations(toast);
        const message = part(host, "message");
        const action = part(host, "action");
        const bounds = toast.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
        for (const element of [message, action]) {
          if (element === action) {
            expect(element.clientHeight).toBeGreaterThanOrEqual(element.scrollHeight);
          } else if (element.scrollHeight > element.clientHeight) {
            element.scrollTop = element.scrollHeight;
            expect(element.scrollTop).toBeGreaterThan(0);
          }
          expect(element.clientWidth).toBeGreaterThanOrEqual(element.scrollWidth);
          expect(element.getBoundingClientRect().width).toBeGreaterThan(0);
        }
        const messageBounds = message.getBoundingClientRect();
        const actionBounds = action.getBoundingClientRect();
        expect(actionBounds.right).toBeLessThanOrEqual(rect(host, "dismiss").left);
        expect(
          messageBounds.right <= actionBounds.left || messageBounds.bottom <= actionBounds.top,
        ).toBe(true);
        const link = recovery.link;
        expect(message.querySelector("a")).toBe(link);
        await expectFocusPreserved(host, link);
        expect(actionBounds.height).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
        const replacement = linkedMessage(
          "#sidebar",
          "Sidebar settings",
          "Another section hidden. ",
        );
        showToast({ ...host.toast!, message: replacement.message });
        await waitForSolid(() => expect(replacement.link.isConnected).toBe(true));
        expect(link.isConnected).toBe(false);
        expect(message.textContent).toBe("Another section hidden. Sidebar settings");
        expect(message.querySelector("a")).toBe(replacement.link);
        await expectFocusPreserved(host, replacement.link);
        host.remove();
        anchor.remove();
      }
    }
  });
});
