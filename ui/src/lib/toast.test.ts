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

async function mountHost(timed = false) {
  if (timed) {
    vi.useFakeTimers();
  }
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await settleHost(host);
  return host;
}

async function show(host: HTMLElementTagNameMap["openclaw-toast-host"], options: ToastOptions) {
  showToast(options);
  await settleHost(host);
}

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
  const anchor = document.createElement("div");
  document.body.append(anchor);
  const bounds = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 100, 100));
  return { anchor, bounds };
}

async function expectTimeout(onDismiss: ReturnType<typeof vi.fn>, remaining: number) {
  await vi.advanceTimersByTimeAsync(remaining - 1);
  expect(onDismiss).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
}

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

describe("shared toast", () => {
  it("reports when no host can present the toast", () => {
    expect(showToast({ message: "Unavailable" })).toBe(false);
  });

  it("shows and replaces the active toast", async () => {
    const host = await mountHost();

    await show(host, { message: "First" });
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("First");

    await show(host, { message: "Second" });
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Second");
  });

  it("routes successive notices through an active modal inside a shadow root", async () => {
    const appHost = await mountHost();
    const { modal } = await shadowModal();
    await show(appHost, { message: "Critical session notice" });

    expect(appHost.parentElement).toBe(modal.getOverlayContainer());
    expect(appHost.textContent).toContain("Critical session notice");

    expect(showToast({ message: "Follow-up session notice" })).toBe(true);
    await settleHost(appHost);
    expect(appHost.textContent).toContain("Follow-up session notice");
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
    await show(appHost, { message: "Outer dialog notice" });

    expect(appHost.parentElement).toBe(outer.getOverlayContainer());
    expect(appHost.textContent).toContain("Outer dialog notice");
  });

  it.each(["hover exit", "render update"])(
    "keeps shadow-root Undo focused through %s and resumes only after focus leaves",
    async (trigger) => {
      const host = await mountHost(true);
      const { owner, root, modal } = await shadowModal();
      const onDismiss = vi.fn();
      await show(host, undoToast({ durationMs: 100, onDismiss }));
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
      await vi.advanceTimersByTimeAsync(200);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(root.activeElement).toBe(action);
      const dismiss = host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
      dismiss.focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(onDismiss).not.toHaveBeenCalled();
      dismiss.blur();
      await expectTimeout(onDismiss, 60);
    },
  );

  it("resumes remaining time when relocation out of a shadow root drops focus", async () => {
    const host = await mountHost(true);
    await shadowModal();
    const onDismiss = vi.fn();
    await show(host, { message: "Session archived", durationMs: 100, onDismiss });
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.append(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await expectTimeout(onDismiss, 60);
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

  it.each(["hover", "focus"])(
    "waits for both interactions to end when %s ends first",
    async (first) => {
      const host = await mountHost(true);
      const onDismiss = vi.fn();
      await show(host, undoToast({ durationMs: 100, onDismiss }));
      await vi.advanceTimersByTimeAsync(40);
      const toast = host.querySelector<HTMLElement>(".app-toast")!;
      const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
      toast.dispatchEvent(new Event("pointerenter"));
      action.focus();
      await vi.advanceTimersByTimeAsync(200);
      const leaveHover = () => toast.dispatchEvent(new Event("pointerleave"));
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
      await expectTimeout(onDismiss, 60);
    },
  );

  it("gives replacements and FIFO successors their own duration without losing retained focus", async () => {
    const host = await mountHost(true);
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const queuedDismiss = vi.fn();
    await show(host, { message: "First", durationMs: 100, onDismiss: firstDismiss });
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    showToast({ message: "Queued", durationMs: 100, fifo: true, onDismiss: queuedDismiss });
    await vi.advanceTimersByTimeAsync(200);
    expect(firstDismiss).not.toHaveBeenCalled();
    await show(host, { message: "Replacement", durationMs: 100, onDismiss: secondDismiss });
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("replaced");
    await vi.advanceTimersByTimeAsync(200);
    expect(secondDismiss).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await settleHost(host);
    expect(secondDismiss).toHaveBeenCalledExactlyOnceWith("dismiss");
    expect(host.textContent).toContain("Queued");
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.blur();
    await expectTimeout(queuedDismiss, 100);
  });

  it("cleans up paused toasts and queued outcomes on removal", async () => {
    vi.useFakeTimers();
    const media = vi.fn(() => ({ matches: false }));
    vi.stubGlobal("matchMedia", media);
    const host = await mountHost();
    const { anchor, bounds } = anchoredToast();
    const firstDismiss = vi.fn();
    const queuedDismiss = vi.fn();
    showToast({ anchor, message: "First", onDismiss: firstDismiss });
    showToast({ message: "Queued", fifo: true, onDismiss: queuedDismiss });
    await settleHost(host);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    bounds.mockClear();
    media.mockClear();
    host.remove();
    expect(bounds).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
    expect(queuedDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
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
    const { anchor, bounds } = anchoredToast();
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    await show(host, undoToast({ anchor, onAction, onDismiss }));
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    action.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    bounds.mockClear();
    media.mockClear();
    action.click();
    await settleHost(host);
    expect(bounds).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("action");
    await show(host, { anchor, message: "Temporary", durationMs: 100 });
    bounds.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    expect(bounds).not.toHaveBeenCalled();
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-reduced-motion: reduce)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not carry hover from a removed toast into later notifications", async () => {
    const host = await mountHost(true);
    await show(host, { message: "First" });
    host.querySelector(".app-toast")!.dispatchEvent(new Event("pointerenter"));
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await settleHost(host);
    expect(host.querySelector(".app-toast")).toBeNull();
    const onDismiss = vi.fn();
    await show(host, { message: "Later", durationMs: 100, onDismiss });
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes after a focused action is removed by replacement", async () => {
    const host = await mountHost(true);
    await show(host, { message: "First", actionLabel: "Undo", onAction: vi.fn() });
    host.querySelector<HTMLButtonElement>(".app-toast__action")!.focus();
    const onDismiss = vi.fn();
    await show(host, { message: "Replacement", durationMs: 100, onDismiss });
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes the remaining duration when a modal relocation drops focus", async () => {
    const host = await mountHost(true);
    const onDismiss = vi.fn();
    await show(host, { message: "First", durationMs: 100, onDismiss });
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("openclaw-modal-dialog");
    document.body.append(modal);
    await modal.updateComplete;
    modal.getOverlayContainer()!.append(host);
    await settleHost(host);
    expect(host.contains(document.activeElement)).toBe(false);
    await expectTimeout(onDismiss, 60);
  });

  it("auto-dismisses after the configured duration", async () => {
    const host = await mountHost(true);
    const { anchor } = anchoredToast();
    await show(host, { anchor, message: "Temporary", durationMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await settleHost(host);

    expect(host.querySelector('.app-toast[data-active="false"]')).not.toBeNull();

    await vi.runAllTimersAsync();
    await settleHost(host);

    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("preserves the dismissal reason when an exiting toast is replaced", async () => {
    const host = await mountHost(true);
    const { anchor } = anchoredToast();
    const reasons: string[] = [];

    await show(host, { anchor, message: "First", onDismiss: (reason) => reasons.push(reason) });
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await settleHost(host);
    showToast({ message: "Second" });

    expect(reasons).toEqual(["dismiss"]);
  });
});
