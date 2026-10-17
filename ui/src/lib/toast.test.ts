/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/modal-dialog.ts";
import { setToastInNavDrawer } from "../app/navigation-surface.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { showToast, type ToastOptions } from "./toast.ts";
import "./toast-host.ts";

async function settleHost(host: HTMLElementTagNameMap["openclaw-toast-host"]) {
  await host.updateComplete;
  await vi.dynamicImportSettled();
  flush();
}

async function show(options: ToastOptions) {
  showToast(options);
  await settleHost(host);
}

const timedToast = (options: Partial<ToastOptions> = {}) =>
  show({ message: "First", durationMs: 100, onDismiss, ...options });

function undoToast(options: Partial<ToastOptions>): ToastOptions {
  return { message: "Session archived", actionLabel: "Undo", onAction: vi.fn(), ...options };
}

async function shadowModal() {
  const owner = document.createElement("div");
  const root = owner.attachShadow({ mode: "open" });
  const modal = document.createElement("openclaw-modal-dialog");
  modal.open = true;
  root.append(modal);
  document.body.append(owner);
  await modal.updateComplete;
  return { owner, root, modal };
}

function anchoredToast() {
  const node = document.createElement("div");
  document.body.append(node);
  const spy = vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  return { anchor: node, bounds: spy };
}

function anchoredHost(reducedMotion: boolean) {
  const media = vi.fn(() => ({ matches: reducedMotion }));
  vi.stubGlobal("matchMedia", media);
  return { media, ...anchoredToast() };
}

async function expectPaused(onDismiss: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(200);
  expect(onDismiss).not.toHaveBeenCalled();
}

async function expectTimeout(onDismiss: ReturnType<typeof vi.fn>, remaining: number) {
  await vi.advanceTimersByTimeAsync(remaining - 1);
  expect(onDismiss).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
}

let restoreDialog: () => void;
let host: HTMLElementTagNameMap["openclaw-toast-host"];
let onDismiss: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  restoreDialog = installDialogPolyfill();
  vi.useFakeTimers();
  onDismiss = vi.fn();
  host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await settleHost(host);
});
afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared toast", () => {
  it("reports when no host can present the toast", () => {
    host.remove();
    expect(showToast({ message: "Unavailable" })).toBe(false);
  });

  it("shows and replaces the active toast", async () => {
    await show({ message: "First" });
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("First");
    await show({ message: "Second" });
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Second");
  });

  it("routes successive notices through an active modal inside a shadow root", async () => {
    const { modal } = await shadowModal();
    await show({ message: "Critical session notice" });
    expect(host.parentElement).toBe(modal.getOverlayContainer());
    expect(host.textContent).toContain("Critical session notice");
    expect(showToast({ message: "Follow-up session notice" })).toBe(true);
    await settleHost(host);
    expect(host.textContent).toContain("Follow-up session notice");
  });

  it("presents toasts in the outer modal after a nested modal closes", async () => {
    const outer = document.createElement("openclaw-modal-dialog");
    const inner = document.createElement("openclaw-modal-dialog");
    outer.append(inner);
    document.body.append(outer);
    await outer.updateComplete;
    await inner.updateComplete;
    inner.hide();
    await inner.updateComplete;
    expect([inner.isConnected, inner.open]).toEqual([true, false]);
    await show({ message: "Outer dialog notice" });
    expect(host.parentElement).toBe(outer.getOverlayContainer());
    expect(host.textContent).toContain("Outer dialog notice");
  });

  it.each(["hover exit", "render update"])("retains shadow focus on %s", async (trigger) => {
    const { owner, root, modal } = await shadowModal();
    await show(undoToast({ durationMs: 100, onDismiss }));
    expect(host.parentElement).toBe(modal.getOverlayContainer());
    await vi.advanceTimersByTimeAsync(40);
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    const toast = host.querySelector<HTMLElement>(".app-toast")!;
    if (trigger === "hover exit") {
      toast.dispatchEvent(new Event("pointerenter"));
    }
    action.focus();
    expect(document.activeElement).toBe(owner);
    expect(root.activeElement).toBe(action);
    if (trigger === "hover exit") {
      toast.dispatchEvent(new Event("pointerleave"));
    } else {
      host.toast = { ...host.toast! };
      await settleHost(host);
    }
    await expectPaused(onDismiss);
    expect(root.activeElement).toBe(action);
    const dismiss = host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
    dismiss.focus();
    await expectPaused(onDismiss);
    dismiss.blur();
    await expectTimeout(onDismiss, 60);
  });

  it.each(["out of a shadow root", "into a modal"])("%s relocation resumes", async (direction) => {
    if (direction === "out of a shadow root") {
      await shadowModal();
    }
    await timedToast();
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await expectPaused(onDismiss);
    let target: HTMLElement = document.body;
    if (direction === "into a modal") {
      const modal = document.createElement("openclaw-modal-dialog");
      document.body.append(modal);
      await modal.updateComplete;
      target = modal.getOverlayContainer()!;
    }
    target.append(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await expectTimeout(onDismiss, 60);
  });

  it("preserves queued outcomes, placement, and the deadline across drawer handoffs", async () => {
    const app = document.createElement("div");
    const shell = document.createElement("div");
    shell.className = "shell";
    const drawer = document.createElement("nav");
    drawer.className = "shell-nav";
    shell.append(drawer, host);
    app.append(shell);
    document.body.append(app);
    showToast({ message: "First", durationMs: 100, onDismiss });
    showToast({ message: "Queued", fifo: true });
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
    expect(host.textContent).toContain("First");
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await settleHost(host);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(host.textContent).toContain("Queued");
  });

  it.each(["hover", "focus"])("waits for %s and the other interaction", async (first) => {
    await show(undoToast({ durationMs: 100, onDismiss }));
    await vi.advanceTimersByTimeAsync(40);
    const toast = host.querySelector<HTMLElement>(".app-toast")!;
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    toast.dispatchEvent(new Event("pointerenter"));
    action.focus();
    await vi.advanceTimersByTimeAsync(200);
    const leaveHover = () => toast.dispatchEvent(new Event("pointerleave"));
    const leaveFocus = () => action.blur();
    const [endFirst, endLast] =
      first === "hover" ? [leaveHover, leaveFocus] : [leaveFocus, leaveHover];
    endFirst();
    await expectPaused(onDismiss);
    endLast();
    await expectTimeout(onDismiss, 60);
  });

  it("gives replacements and FIFO successors their own duration without losing retained focus", async () => {
    const [firstDismiss, secondDismiss, queuedDismiss] = [vi.fn(), vi.fn(), vi.fn()];
    await show({ message: "First", durationMs: 100, onDismiss: firstDismiss });
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    showToast({ message: "Queued", durationMs: 100, fifo: true, onDismiss: queuedDismiss });
    await expectPaused(firstDismiss);
    await show({ message: "Replacement", durationMs: 100, onDismiss: secondDismiss });
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("replaced");
    await expectPaused(secondDismiss);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await settleHost(host);
    expect(secondDismiss).toHaveBeenCalledExactlyOnceWith("dismiss");
    expect(host.textContent).toContain("Queued");
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.blur();
    await expectTimeout(queuedDismiss, 100);
  });

  it("cleans up paused toasts and queued outcomes on removal", async () => {
    const { anchor, bounds, media } = anchoredHost(false);
    const [firstDismiss, queuedDismiss] = [vi.fn(), vi.fn()];
    showToast({ anchor, message: "First", onDismiss: firstDismiss });
    showToast({ message: "Queued", fifo: true, onDismiss: queuedDismiss });
    await settleHost(host);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    bounds.mockClear();
    media.mockClear();
    host.remove();
    expect([bounds.mock.calls, media.mock.calls]).toEqual([[], []]);
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
    expect(queuedDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    document.body.append(host);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("still runs a focused action immediately and honors reduced-motion dismissal", async () => {
    const { anchor, bounds, media } = anchoredHost(true);
    const onAction = vi.fn();
    await show(undoToast({ anchor, onAction, onDismiss }));
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    action.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    bounds.mockClear();
    media.mockClear();
    action.click();
    await settleHost(host);
    expect([bounds.mock.calls, media.mock.calls]).toEqual([[], []]);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("action");
    await show({ anchor, message: "Temporary", durationMs: 100 });
    bounds.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    expect(bounds).not.toHaveBeenCalled();
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-reduced-motion: reduce)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not carry hover from a removed toast into later notifications", async () => {
    await show({ message: "First" });
    host.querySelector(".app-toast")!.dispatchEvent(new Event("pointerenter"));
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    await timedToast({ message: "Later" });
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes after a focused action is removed by replacement", async () => {
    await show({ message: "First", actionLabel: "Undo", onAction: vi.fn() });
    host.querySelector<HTMLButtonElement>(".app-toast__action")!.focus();
    await timedToast({ message: "Replacement" });
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("auto-dismisses after the configured duration", async () => {
    const { anchor } = anchoredToast();
    await show({ anchor, message: "Temporary", durationMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await settleHost(host);
    expect(host.querySelector('.app-toast[data-active="false"]')).not.toBeNull();
    await vi.runAllTimersAsync();
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("preserves the dismissal reason when an exiting toast is replaced", async () => {
    const { anchor } = anchoredToast();
    const reasons: string[] = [];
    await show({ anchor, message: "First", onDismiss: (reason) => reasons.push(reason) });
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await settleHost(host);
    showToast({ message: "Second" });
    expect(reasons).toEqual(["dismiss"]);
  });
});
