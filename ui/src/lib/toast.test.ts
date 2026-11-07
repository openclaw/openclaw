/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import "../components/modal-dialog.tsx";
import { setToastInNavDrawer } from "../app/navigation-surface.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { showToast, type ToastOptions } from "./toast.ts";
import "./toast-host.tsx";

// Dismissed and timed-out toasts fade out before they report.
const EXIT_MS = 200;

async function settleHost(host: HTMLElementTagNameMap["openclaw-toast-host"]) {
  await host.updateComplete;
  await vi.dynamicImportSettled();
  flush();
}

async function mountHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await settleHost(host);
  return host;
}

const titles = (host: HTMLElement) =>
  [...host.querySelectorAll(".app-toast__message")].map((element) => element.textContent);
const lane = (host: HTMLElement, name = "top-center") =>
  host.querySelector<HTMLElement>(`.app-toast-lane--${name}`)!;

let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});
afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("requires an explicit severity, including neutral outcomes", () => {
  expectTypeOf<{ message: string }>().not.toMatchTypeOf<ToastOptions>();
  expectTypeOf<{ message: string; severity: undefined }>().toMatchTypeOf<ToastOptions>();
});

describe("shared toast", () => {
  it("keeps redacted error details collapsed until opened", async () => {
    const host = await mountHost();
    showToast({
      severity: undefined,
      message: "Couldn’t save this setting. Try again.",
      detail: "Request failed: token=sk-123456789012345678901234567890",
      durationMs: 60_000,
    });
    await settleHost(host);
    const details = host.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Show details");
    expect(details.textContent).not.toContain("sk-123456789012345678901234567890");
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    showToast({
      severity: undefined,
      message: "Couldn’t save this setting. Try again.",
      detail: "Request failed: token=sk-123456789012345678901234567890",
      durationMs: 60_000,
    });
    await settleHost(host);
    expect(host.querySelector("details")?.open).toBe(false);
  });
  it("holds outcomes until a host can present them", async () => {
    expect(showToast({ severity: undefined, message: "Early" })).toBe(false);
    const host = await mountHost();
    await settleHost(host);
    expect(titles(host)).toEqual(["Early"]);
  });

  it("stacks toasts newest first and restarts a repeated message", async () => {
    const host = await mountHost();
    const firstDismiss = vi.fn();
    showToast({ severity: undefined, message: "First", onDismiss: firstDismiss });
    showToast({ severity: undefined, message: "Second" });
    await settleHost(host);
    expect(titles(host)).toEqual(["Second", "First"]);
    expect(
      [...host.querySelectorAll<HTMLElement>(".app-toast")].map((toast) => toast.dataset.depth),
    ).toEqual(["0", "1"]);

    showToast({ severity: undefined, message: "First" });
    await settleHost(host);
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("replaced");
    expect(titles(host)).toEqual(["First", "Second"]);
  });

  it("keeps equal copy distinct by key and replaces only the matching notice", async () => {
    const host = await mountHost();
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const message = "Session started";
    showToast({ severity: "success", message, dedupeKey: "first", onDismiss: firstDismiss });
    showToast({ severity: "success", message, dedupeKey: "second", onDismiss: secondDismiss });
    showToast({ severity: "success", message });
    await settleHost(host);
    expect(titles(host)).toEqual([message, message, message]);

    showToast({ severity: "success", message: "Session created", dedupeKey: "first" });
    await settleHost(host);
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("replaced");
    expect(secondDismiss).not.toHaveBeenCalled();
    expect(titles(host)).toEqual(["Session created", message, message]);
  });

  it("separates actions in the center from arrivals on the right", async () => {
    const host = await mountHost();
    showToast({ severity: undefined, message: "Session archived" });
    showToast({ severity: undefined, message: "Release check: Failed", placement: "top-right" });
    await settleHost(host);
    expect(lane(host).textContent).toContain("Session archived");
    expect(lane(host, "top-right").textContent).toContain("Release check: Failed");
  });

  it("routes successive notices through an active modal inside a shadow root", async () => {
    const appHost = await mountHost();
    const shadowOwner = document.createElement("div");
    const shadowRoot = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    shadowRoot.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;

    showToast({ severity: undefined, message: "Critical session notice" });
    await settleHost(appHost);

    expect(appHost.parentElement).toBe(modal.getOverlayContainer());
    expect(appHost.textContent).toContain("Critical session notice");

    expect(showToast({ severity: undefined, message: "Follow-up session notice" })).toBe(true);
    await settleHost(appHost);
    expect(appHost.textContent).toContain("Follow-up session notice");
  });

  it("does not resurrect a modal toast when document content is removed", async () => {
    const host = await mountHost();
    const modal = document.createElement("openclaw-modal-dialog");
    document.body.append(modal);
    await modal.updateComplete;
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "Saved", onDismiss });
    await settleHost(host);
    expect(host.parentElement).toBe(modal.getOverlayContainer());

    document.body.replaceChildren();
    await vi.dynamicImportSettled();
    flush();

    expect(host.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(0);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
  });

  it("presents toasts in the outer modal after a nested modal closes", async () => {
    const appHost = await mountHost();
    const outer = document.createElement("openclaw-modal-dialog");
    const inner = document.createElement("openclaw-modal-dialog");
    outer.append(inner);
    document.body.append(outer);
    await outer.updateComplete;
    await inner.updateComplete;
    inner.hide();
    await inner.updateComplete;

    expect(inner.isConnected).toBe(true);
    expect(inner.open).toBe(false);
    showToast({ severity: undefined, message: "Outer dialog notice" });
    await settleHost(appHost);

    expect(appHost.parentElement).toBe(outer.getOverlayContainer());
    expect(appHost.textContent).toContain("Outer dialog notice");
  });

  it("keeps shadow-root Undo focused through hover exit and resumes only after focus leaves", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const shadowOwner = document.createElement("div");
    const root = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    root.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;
    const onDismiss = vi.fn();
    showToast({
      severity: undefined,
      message: "Session archived",
      actionLabel: "Undo",
      onAction: vi.fn(),
      durationMs: 100,
      onDismiss,
    });
    await settleHost(host);
    expect(host.parentElement).toBe(modal.getOverlayContainer());
    await vi.advanceTimersByTimeAsync(40);
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    lane(host).dispatchEvent(new Event("pointerenter"));
    action.focus();
    expect(document.activeElement).toBe(shadowOwner);
    expect(root.activeElement).toBe(action);
    lane(host).dispatchEvent(new Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(200);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(root.activeElement).toBe(action);
    const dismiss = host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
    dismiss.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(onDismiss).not.toHaveBeenCalled();
    dismiss.blur();
    await vi.advanceTimersByTimeAsync(59);
    expect(host.querySelector('.app-toast[data-active="false"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + EXIT_MS);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes remaining time when relocation out of a shadow root drops focus", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const shadowOwner = document.createElement("div");
    const root = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    root.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "Session archived", durationMs: 100, onDismiss });
    await settleHost(host);
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.append(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(59);
    expect(host.querySelector('.app-toast[data-active="false"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + EXIT_MS);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("preserves queued outcomes, placement, and the deadline across drawer handoffs", async () => {
    vi.useFakeTimers();
    const app = document.createElement("div");
    const shell = document.createElement("div");
    shell.className = "shell";
    const drawer = document.createElement("nav");
    drawer.className = "shell-nav";
    const host = document.createElement("openclaw-toast-host");
    shell.append(drawer, host);
    app.append(shell);
    document.body.append(app);
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "First", durationMs: 100, onDismiss });
    showToast({ severity: undefined, message: "Second", durationMs: 1_000 });
    await vi.advanceTimersByTimeAsync(40);

    const elements = { navDrawerElement: drawer, shellElement: shell, toastElement: host };
    setToastInNavDrawer(elements, true);
    await settleHost(host);
    expect(host.parentElement).toBe(drawer);
    expect(host.dataset.toastPlacement).toBe("overlay");
    expect(host.textContent).toContain("First");
    await vi.advanceTimersByTimeAsync(40);
    setToastInNavDrawer(elements, false);
    await settleHost(host);
    expect(host.parentElement).toBe(shell);
    expect(host.dataset.toastPlacement).toBe("shell");
    expect(titles(host)).toEqual(["Second", "First"]);
    expect(onDismiss).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20 + EXIT_MS);
    await settleHost(host);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(titles(host)).toEqual(["Second"]);
  });

  it.each(["hover", "focus"])(
    "waits for both interactions to end when %s ends first",
    async (first) => {
      vi.useFakeTimers();
      const host = await mountHost();
      const onDismiss = vi.fn();
      showToast({
        severity: undefined,
        message: "Session archived",
        actionLabel: "Undo",
        onAction: vi.fn(),
        durationMs: 100,
        onDismiss,
      });
      await settleHost(host);
      await vi.advanceTimersByTimeAsync(40);
      const stack = lane(host);
      const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
      stack.dispatchEvent(new Event("pointerenter"));
      action.focus();
      await vi.advanceTimersByTimeAsync(200);
      await settleHost(host);
      expect(stack.hasAttribute("data-open")).toBe(true);
      const leaveHover = () => stack.dispatchEvent(new Event("pointerleave"));
      if (first === "hover") {
        leaveHover();
      } else {
        action.blur();
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(onDismiss).not.toHaveBeenCalled();
      if (first === "hover") {
        action.blur();
      } else {
        leaveHover();
      }
      await vi.advanceTimersByTimeAsync(59 + EXIT_MS);
      expect(onDismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    },
  );

  it("keeps the fourth toast hidden and paused until a slot frees", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const dismissed: string[] = [];
    for (const name of ["One", "Two", "Three", "Four"]) {
      showToast({
        severity: undefined,
        message: name,
        durationMs: 100,
        onDismiss: () => dismissed.push(name),
      });
    }
    await settleHost(host);
    const oldest = [...host.querySelectorAll<HTMLElement>(".app-toast")].at(-1)!;
    expect(oldest.dataset.depth).toBe("3");
    expect(oldest.hasAttribute("inert")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await settleHost(host);
    // The three visible toasts leave; the waiting one moves to the front and starts.
    expect(oldest.dataset.depth).toBe("0");
    await vi.advanceTimersByTimeAsync(99);
    await settleHost(host);
    expect(oldest.dataset.active).toBe("true");
    expect(dismissed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + EXIT_MS);
    expect(dismissed.slice(0, 3).toSorted()).toEqual(["Four", "Three", "Two"]);
    expect(dismissed.at(-1)).toBe("One");
  });

  it("dismisses the focused toast on Escape", async () => {
    const host = await mountHost();
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "Session archived", onDismiss });
    await settleHost(host);
    const toast = host.querySelector<HTMLElement>(".app-toast")!;
    toast.focus();
    toast.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settleHost(host);
    expect(toast.dataset.active).toBe("false");
  });

  it("cleans up paused toasts and waiting outcomes on removal", async () => {
    vi.useFakeTimers();
    const media = vi.fn(() => ({ matches: false }));
    vi.stubGlobal("matchMedia", media);
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    showToast({ severity: undefined, anchor, message: "First", onDismiss: firstDismiss });
    showToast({ severity: undefined, message: "Second", onDismiss: secondDismiss });
    await settleHost(host);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    media.mockClear();
    host.remove();
    expect(media).not.toHaveBeenCalled();
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
    expect(secondDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    document.body.append(host);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("still runs a focused action immediately and honors reduced-motion dismissal", async () => {
    vi.useFakeTimers();
    const media = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", media);
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    showToast({
      severity: undefined,
      anchor,
      message: "Session archived",
      actionLabel: "Undo",
      onAction,
      onDismiss,
    });
    await settleHost(host);
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    action.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    media.mockClear();
    action.click();
    await settleHost(host);
    expect(media).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("action");
    showToast({ severity: undefined, anchor, message: "Temporary", durationMs: 100 });
    await settleHost(host);
    await vi.advanceTimersByTimeAsync(100);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-reduced-motion: reduce)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not carry hover from a removed toast into later notifications", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    showToast({ severity: undefined, message: "First" });
    await settleHost(host);
    lane(host).dispatchEvent(new Event("pointerenter"));
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await vi.advanceTimersByTimeAsync(EXIT_MS);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "Later", durationMs: 100, onDismiss });
    await settleHost(host);
    await vi.advanceTimersByTimeAsync(100 + EXIT_MS);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes the stack after its focused toast runs its action", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    showToast({ severity: undefined, message: "First", actionLabel: "Undo", onAction: vi.fn() });
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "Second", durationMs: 100, onDismiss });
    await settleHost(host);
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    action.focus();
    await vi.advanceTimersByTimeAsync(500);
    expect(onDismiss).not.toHaveBeenCalled();
    action.click();
    await settleHost(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(100 + EXIT_MS);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes the remaining duration when a modal relocation drops focus", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const onDismiss = vi.fn();
    showToast({ severity: undefined, message: "First", durationMs: 100, onDismiss });
    await settleHost(host);
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("openclaw-modal-dialog");
    document.body.append(modal);
    await modal.updateComplete;
    modal.getOverlayContainer()!.append(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(59 + EXIT_MS);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("auto-dismisses an anchored notice after the configured duration", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));

    showToast({ severity: undefined, anchor, message: "Temporary", durationMs: 50 });
    await settleHost(host);
    expect(host.querySelector(".app-toast-lane .app-toast")).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    await settleHost(host);

    expect(host.querySelector('.app-toast--anchored[data-active="false"]')).not.toBeNull();

    await vi.runAllTimersAsync();
    await settleHost(host);

    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("reports the dismissal reason once the exit ends", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const reasons: string[] = [];

    showToast({
      severity: undefined,
      anchor,
      message: "First",
      onDismiss: (reason) => reasons.push(reason),
    });
    await settleHost(host);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await settleHost(host);
    showToast({ severity: undefined, message: "Second" });
    await vi.runOnlyPendingTimersAsync();

    expect(reasons).toEqual(["dismiss"]);
  });
});
