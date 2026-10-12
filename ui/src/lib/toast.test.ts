/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/modal-dialog.ts";
import { moveToastToNavDrawer, restoreToastFromNavDrawer } from "../app/navigation-surface.ts";
import { showToast } from "./toast.ts";

async function mountHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
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

    showToast({ message: "First" });
    await host.updateComplete;
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("First");

    showToast({ message: "Second" });
    await host.updateComplete;
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Second");
  });

  it("keeps queued outcomes behind an unrelated replacement toast", async () => {
    const host = await mountHost();

    showToast({ message: "First completion", fifo: true });
    showToast({ message: "Second completion", fifo: true });
    await host.updateComplete;
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("First completion");

    showToast({ message: "Critical observer notice" });
    await host.updateComplete;
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Critical observer notice");
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await host.updateComplete;
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Second completion");
  });

  it("uses the active modal's toast layer before the app layer", async () => {
    const appHost = await mountHost();
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    document.body.append(modal);
    await modal.updateComplete;

    showToast({ message: "Above overlay" });
    await appHost.updateComplete;

    expect(appHost.parentElement).toBe(modal);
    expect(appHost.textContent).toContain("Above overlay");
  });

  it("routes through an active modal inside a shadow root", async () => {
    const appHost = await mountHost();
    const shadowOwner = document.createElement("div");
    const shadowRoot = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    shadowRoot.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;

    showToast({ message: "Critical session notice" });
    await appHost.updateComplete;

    expect(appHost.parentElement).toBe(modal);
    expect(appHost.textContent).toContain("Critical session notice");
  });

  it.each(["hover exit", "render update"])(
    "keeps shadow-root Undo focused through %s and resumes only after focus leaves",
    async (trigger) => {
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
        message: "Session archived",
        actionLabel: "Undo",
        onAction: vi.fn(),
        durationMs: 100,
        onDismiss,
      });
      await host.updateComplete;
      expect(host.parentElement).toBe(modal);
      await vi.advanceTimersByTimeAsync(40);
      const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
      const toast = host.querySelector<HTMLElement>(".app-toast")!;
      if (trigger === "hover exit") {
        toast.dispatchEvent(new Event("pointerenter"));
      }
      action.focus();
      expect(document.activeElement).toBe(shadowOwner);
      expect(root.activeElement).toBe(action);
      if (trigger === "hover exit") {
        toast.dispatchEvent(new Event("pointerleave"));
      } else {
        host.requestUpdate();
        await host.updateComplete;
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(root.activeElement).toBe(action);
      const dismiss = host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
      dismiss.focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(onDismiss).not.toHaveBeenCalled();
      dismiss.blur();
      await vi.advanceTimersByTimeAsync(59);
      expect(onDismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    },
  );

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
    showToast({ message: "Session archived", durationMs: 100, onDismiss });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.append(host);
    await host.updateComplete;
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(59);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
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
    showToast({ message: "First", durationMs: 100, onDismiss });
    showToast({ message: "Queued", fifo: true });
    await vi.advanceTimersByTimeAsync(40);

    moveToastToNavDrawer(app);
    await host.updateComplete;
    expect(host.parentElement).toBe(drawer);
    expect(host.dataset.toastPlacement).toBe("overlay");
    expect(host.textContent).toContain("First");
    await vi.advanceTimersByTimeAsync(40);
    restoreToastFromNavDrawer(app);
    await host.updateComplete;
    expect(host.parentElement).toBe(shell);
    expect(host.dataset.toastPlacement).toBe("shell");
    expect(host.textContent).toContain("First");
    expect(onDismiss).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await host.updateComplete;
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(host.textContent).toContain("Queued");
  });

  it("keeps Undo available while focus moves within the toast and resumes the remaining time", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const onDismiss = vi.fn();
    showToast({ message: "Session archived", actionLabel: "Undo", onAction: vi.fn(), onDismiss });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(2_000);
    host.querySelector<HTMLButtonElement>(".app-toast__action")!.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    expect(host.querySelector(".app-toast__action")).toBe(document.activeElement);
    expect(onDismiss).not.toHaveBeenCalled();
    const dismiss = host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
    dismiss.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    expect(onDismiss).not.toHaveBeenCalled();
    dismiss.blur();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it.each(["hover", "focus"])(
    "waits for both interactions to end when %s ends first",
    async (first) => {
      vi.useFakeTimers();
      const host = await mountHost();
      const onDismiss = vi.fn();
      showToast({
        message: "Session archived",
        actionLabel: "Undo",
        onAction: vi.fn(),
        durationMs: 100,
        onDismiss,
      });
      await host.updateComplete;
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
      await vi.advanceTimersByTimeAsync(59);
      expect(onDismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    },
  );

  it("gives replacements and FIFO successors their own duration without losing retained focus", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const queuedDismiss = vi.fn();
    showToast({ message: "First", durationMs: 100, onDismiss: firstDismiss });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    showToast({ message: "Queued", durationMs: 100, fifo: true, onDismiss: queuedDismiss });
    await vi.advanceTimersByTimeAsync(200);
    expect(firstDismiss).not.toHaveBeenCalled();
    showToast({ message: "Replacement", durationMs: 100, onDismiss: secondDismiss });
    await host.updateComplete;
    expect(firstDismiss).toHaveBeenCalledExactlyOnceWith("replaced");
    await vi.advanceTimersByTimeAsync(200);
    expect(secondDismiss).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await host.updateComplete;
    expect(secondDismiss).toHaveBeenCalledExactlyOnceWith("dismiss");
    expect(host.textContent).toContain("Queued");
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.blur();
    await vi.advanceTimersByTimeAsync(99);
    expect(queuedDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queuedDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("cleans up paused toasts and queued outcomes on removal", async () => {
    vi.useFakeTimers();
    const media = vi.fn(() => ({ matches: false }));
    vi.stubGlobal("matchMedia", media);
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const bounds = vi
      .spyOn(anchor, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 100, 100));
    const firstDismiss = vi.fn();
    const queuedDismiss = vi.fn();
    showToast({ anchor, message: "First", onDismiss: firstDismiss });
    showToast({ message: "Queued", fifo: true, onDismiss: queuedDismiss });
    await host.updateComplete;
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
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("still runs a focused action immediately and honors reduced-motion dismissal", async () => {
    vi.useFakeTimers();
    const media = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", media);
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const bounds = vi
      .spyOn(anchor, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 100, 100));
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    showToast({ anchor, message: "Session archived", actionLabel: "Undo", onAction, onDismiss });
    await host.updateComplete;
    const action = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    action.focus();
    await vi.advanceTimersByTimeAsync(6_100);
    bounds.mockClear();
    media.mockClear();
    action.click();
    await host.updateComplete;
    expect(bounds).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("action");
    showToast({ anchor, message: "Temporary", durationMs: 100 });
    await host.updateComplete;
    bounds.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();
    expect(bounds).not.toHaveBeenCalled();
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-reduced-motion: reduce)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not carry hover from a removed toast into later notifications", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    showToast({ message: "First" });
    await host.updateComplete;
    host.querySelector(".app-toast")!.dispatchEvent(new Event("pointerenter"));
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();
    const onDismiss = vi.fn();
    showToast({ message: "Later", durationMs: 100, onDismiss });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes after a focused action is removed by replacement", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    showToast({ message: "First", actionLabel: "Undo", onAction: vi.fn() });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__action")!.focus();
    const onDismiss = vi.fn();
    showToast({ message: "Replacement", durationMs: 100, onDismiss });
    await host.updateComplete;
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("resumes the remaining duration when a modal relocation drops focus", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const onDismiss = vi.fn();
    showToast({ message: "First", durationMs: 100, onDismiss });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(40);
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.focus();
    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("openclaw-modal-dialog");
    document.body.append(modal);
    await modal.updateComplete;
    modal.append(host);
    await host.updateComplete;
    expect(host.contains(document.activeElement)).toBe(false);
    await vi.advanceTimersByTimeAsync(59);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("auto-dismisses after the configured duration", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));

    showToast({ anchor, message: "Temporary", durationMs: 50 });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await host.updateComplete;

    expect(host.querySelector('.app-toast[data-active="false"]')).not.toBeNull();

    await vi.runAllTimersAsync();
    await host.updateComplete;

    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("preserves the dismissal reason when an exiting toast is replaced", async () => {
    vi.useFakeTimers();
    const host = await mountHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const reasons: string[] = [];

    showToast({ anchor, message: "First", onDismiss: (reason) => reasons.push(reason) });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await host.updateComplete;
    showToast({ message: "Second" });

    expect(reasons).toEqual(["dismiss"]);
  });

  it("reports why a toast is replaced, dismissed, acted on, or disconnected", async () => {
    const host = await mountHost();
    const reasons: string[] = [];

    showToast({ message: "First", onDismiss: (reason) => reasons.push(reason) });
    showToast({
      message: "Second",
      actionLabel: "Undo",
      onAction: () => reasons.push("ran-action"),
      onDismiss: (reason) => reasons.push(reason),
    });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();

    showToast({ message: "Third", onDismiss: (reason) => reasons.push(reason) });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();

    showToast({ message: "Fourth", onDismiss: (reason) => reasons.push(reason) });
    host.remove();

    expect(reasons).toEqual(["replaced", "action", "ran-action", "dismiss", "disconnected"]);
  });
});
