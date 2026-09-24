/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { moveToastToNavDrawer, restoreToastFromNavDrawer } from "../app/navigation-surface.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { showToast } from "./toast.ts";

type ToastView = typeof import("./toast-view.ts");

async function mountHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

describe("lazy toast presentation", () => {
  let loading: ReturnType<typeof createDeferred<ToastView>>;
  let view: ToastView;
  let load: ReturnType<typeof vi.fn<() => Promise<ToastView>>>;

  beforeEach(async () => {
    // Delay the module boundary, not the renderer: assertions exercise the real
    // template and the registered host's queue, abort, focus, and timer owner.
    view = await vi.importActual<ToastView>("./toast-view.ts");
    loading = createDeferred<ToastView>();
    load = vi.fn(() => loading.promise);
    vi.doMock("./toast-view.ts", load);
  });

  afterEach(async () => {
    document.body.replaceChildren();
    loading.resolve(view);
    await vi.dynamicImportSettled();
    vi.doUnmock("./toast-view.ts");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("loads only for a real toast and gives the latest queued outcome its visible duration", async () => {
    const empty = await mountHost();
    expect(load).not.toHaveBeenCalled();
    empty.remove();
    const onDismiss = vi.fn();
    expect(showToast({ message: "Restored startup outcome", durationMs: 100, onDismiss })).toBe(
      false,
    );
    expect(load).not.toHaveBeenCalled();
    const host = document.createElement("openclaw-toast-host");
    document.body.append(host);
    await waitForFast(() => expect(load).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.querySelector(".app-toast")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    loading.resolve(view);
    await host.updateComplete;
    expect(host.textContent).toContain("Restored startup outcome");
    await vi.advanceTimersByTimeAsync(99);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
    showToast({ message: "Next outcome" });
    await host.updateComplete;
    expect(host.textContent).toContain("Next outcome");
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "cancel-all", "replace", "disconnect"] as const)(
    "never renders stale first-load content after %s and preserves queued outcomes",
    async (boundary) => {
      const host = await mountHost();
      const abort = new AbortController();
      const firstDismiss = vi.fn();
      const queuedDismiss = vi.fn();
      showToast({ message: "Obsolete", signal: abort.signal, onDismiss: firstDismiss });
      showToast({
        message: "FIFO successor",
        fifo: true,
        signal: boundary === "cancel-all" ? abort.signal : undefined,
        onDismiss: queuedDismiss,
      });
      await waitForFast(() => expect(load).toHaveBeenCalledOnce());
      if (boundary === "cancel" || boundary === "cancel-all") {
        abort.abort();
      } else if (boundary === "replace") {
        showToast({ message: "Replacement" });
      } else {
        host.remove();
      }
      loading.resolve(view);
      await host.updateComplete;
      expect(host.textContent).not.toContain("Obsolete");
      expect(firstDismiss).toHaveBeenCalledExactlyOnceWith(
        boundary === "replace"
          ? "replaced"
          : boundary === "disconnect"
            ? "disconnected"
            : "cancelled",
      );
      if (boundary === "cancel-all") {
        expect(host.querySelector(".app-toast")).toBeNull();
        expect(queuedDismiss).toHaveBeenCalledExactlyOnceWith("cancelled");
      } else if (boundary === "disconnect") {
        document.body.append(host);
        await host.updateComplete;
        expect(host.querySelector(".app-toast")).toBeNull();
        expect(queuedDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
      } else {
        if (boundary === "replace") {
          expect(host.textContent).toContain("Replacement");
          host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
          await host.updateComplete;
        }
        expect(host.textContent).toContain("FIFO successor");
        expect(queuedDismiss).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves first-load placement through drawer handoffs and focused Undo after loading", async () => {
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
    showToast({
      message: "Archived",
      actionLabel: "Undo",
      onAction: vi.fn(),
      durationMs: 100,
      onDismiss,
    });
    await waitForFast(() => expect(load).toHaveBeenCalledOnce());
    moveToastToNavDrawer(app);
    expect(host.parentElement).toBe(drawer);
    restoreToastFromNavDrawer(app);
    expect(host.parentElement).toBe(shell);
    expect(host.dataset.toastPlacement).toBe("shell");
    vi.useFakeTimers();
    loading.resolve(view);
    await host.updateComplete;
    const undo = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    undo.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDismiss).not.toHaveBeenCalled();
    undo.blur();
    await vi.advanceTimersByTimeAsync(100);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("keeps a failed first load visible and retryable without consuming the outcome or its queue", async () => {
    const host = await mountHost();
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    showToast({
      message: html`Original outcome with <a href="#settings">recovery link</a>`,
      actionLabel: "Undo",
      onAction,
      durationMs: 100,
      onDismiss,
    });
    showToast({ message: "Next outcome", fifo: true });
    await waitForFast(() => expect(load).toHaveBeenCalledOnce());
    loading.reject(new Error("chunk unavailable"));
    await host.updateComplete;
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "This view could not load",
    );
    const retry = host.querySelector<HTMLButtonElement>(".app-toast__action")!;
    expect(retry.textContent?.trim()).toBe("Retry");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    const retryLoad = vi.fn(() => view);
    vi.doMock("./toast-view.ts", retryLoad);
    retry.click();
    await host.updateComplete;
    expect(retryLoad).toHaveBeenCalledOnce();
    expect(host.querySelector('a[href="#settings"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".app-toast__action")!.click();
    await host.updateComplete;
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("action");
    expect(host.textContent).toContain("Next outcome");
  });
});
