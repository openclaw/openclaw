import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import "../styles.css";
import { showToast, type ToastOptions } from "./toast.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function showArchiveToast(options: Partial<ToastOptions> = {}) {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  showToast({
    message: "Session archived",
    actionLabel: "Undo",
    onAction: () => undefined,
    durationMs: 60_000,
    ...options,
  });
  await host.updateComplete;
  return host;
}

describe.skipIf(!hasBrowserLayout)("toast browser layout", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps mobile actions trailing while the desktop toast stays compact", async () => {
    await useViewport(390, 844);
    const mobileHost = await showArchiveToast();
    const mobileToast = mobileHost.querySelector<HTMLElement>(".app-toast")!;
    const mobileAction = mobileHost.querySelector<HTMLElement>(".app-toast__action")!;
    const mobileDismiss = mobileHost.querySelector<HTMLElement>(".app-toast__dismiss")!;
    const mobileToastBounds = mobileToast.getBoundingClientRect();

    expect(mobileToastBounds.top).toBeCloseTo(20, 0);
    expect(mobileToastBounds.left).toBeCloseTo(12, 0);
    expect(mobileToastBounds.right).toBeCloseTo(378, 0);
    expect(mobileAction.getBoundingClientRect().left).toBeGreaterThan(
      mobileToastBounds.left + mobileToastBounds.width * 0.6,
    );
    expect(mobileDismiss.getBoundingClientRect().right).toBeLessThanOrEqual(
      mobileToastBounds.right - 7,
    );

    expect(mobileAction.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(mobileDismiss.getBoundingClientRect().height).toBe(44);

    mobileHost.remove();
    await useViewport(1280, 800);
    const desktopHost = await showArchiveToast();
    const desktopToast = desktopHost.querySelector<HTMLElement>(".app-toast")!;
    expect(desktopToast.getBoundingClientRect().top).toBeCloseTo(20, 0);
    expect(desktopToast.getBoundingClientRect().width).toBeLessThan(320);
    expect(desktopToast.getBoundingClientRect().height).toBeLessThan(60);
    expect(desktopHost.querySelector(".app-toast__dismiss")!.getBoundingClientRect().height).toBe(
      32,
    );
  });
  it("keeps settings feedback at the safe lower edge without moving anchored notices", async () => {
    for (const width of [1280, 390]) {
      await useViewport(width, 844);
      const host = await showArchiveToast({ placement: "bottom" });
      host.style.setProperty("--safe-area-bottom", "24px");
      const toast = host.querySelector<HTMLElement>(".app-toast")!;
      await Promise.all(toast.getAnimations().map((animation) => animation.finished));
      const bounds = toast.getBoundingClientRect();
      expect(bounds.bottom).toBeCloseTo(800, 0);
      expect(bounds.right).toBeCloseTo(width - (width === 390 ? 12 : 20), 0);
      expect(host.querySelector(".app-toast__dismiss")!.getBoundingClientRect().height).toBe(
        width === 390 ? 44 : 32,
      );
      host.remove();
    }

    const anchor = document.createElement("div");
    anchor.style.cssText = "position: fixed; top: 100px; left: 20px; width: 350px; height: 100px";
    document.body.append(anchor);
    const host = await showArchiveToast({ anchor, placement: "bottom" });
    const toast = host.querySelector<HTMLElement>(".app-toast")!;
    expect(toast.classList.contains("app-toast--bottom")).toBe(false);
    expect(getComputedStyle(toast).top).toBe("100px");
  });

  it("keeps oversized errors scrollable with actions inside a short phone viewport", async () => {
    await useViewport(320, 400);
    for (const placement of ["top", "bottom"] as const) {
      const host = await showArchiveToast({
        placement,
        message: "The connection was interrupted. Please check your settings. ".repeat(100),
      });
      const toast = host.querySelector<HTMLElement>(".app-toast")!;
      await Promise.all(toast.getAnimations().map((animation) => animation.finished));
      const message = host.querySelector<HTMLElement>(".app-toast__message")!;
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
        const anchor = document.createElement("div");
        anchor.style.cssText =
          `position: fixed; top: 100px; left: 0; width: ` + width + "px; height: 100px";
        document.body.append(anchor);
        const host = await showArchiveToast({
          message: html`Your changes could not be saved because the connection was interrupted. Keep
            this tab open, check <a href="#settings">Gateway settings</a>, and try again when the
            connection is restored.`,
          actionLabel: "Discard unsaved changes and reload",
          ...(placement === "anchored" ? { anchor } : { placement }),
        });
        host.style.setProperty("--control-ui-text-scale", "1.3");
        const toast = host.querySelector<HTMLElement>(".app-toast")!;
        await Promise.all(toast.getAnimations().map((animation) => animation.finished));
        const message = host.querySelector<HTMLElement>(".app-toast__message")!;
        const action = host.querySelector<HTMLElement>(".app-toast__action")!;
        const dismiss = host.querySelector<HTMLElement>(".app-toast__dismiss")!;
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
        expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(
          dismiss.getBoundingClientRect().left,
        );
        const messageBounds = message.getBoundingClientRect();
        const actionBounds = action.getBoundingClientRect();
        expect(
          messageBounds.right <= actionBounds.left || messageBounds.bottom <= actionBounds.top,
        ).toBe(true);
        const link = message.querySelector("a")!;
        link.focus();
        expect(document.activeElement).toBe(link);
        expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
        host.remove();
        anchor.remove();
      }
    }
  });
});
