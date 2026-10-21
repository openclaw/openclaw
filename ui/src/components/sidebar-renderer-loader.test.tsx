/* @vitest-environment jsdom */

import { createSignal, flush, lazy, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createSidebarRendererLoader } from "./sidebar-renderer-loader.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["idle", "online"] as const)(
  "recovers a mounted renderer after an %s retry without replacing its popup",
  async (retry) => {
    let idle: IdleRequestCallback | undefined;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(retry === "idle");
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idle = callback;
      return 1;
    });
    const imported = { Renderer: () => <button type="button">Loaded action</button> };
    const importModule = vi
      .fn<() => Promise<typeof imported>>()
      .mockRejectedValueOnce(new Error("offline chunk"))
      .mockResolvedValue(imported);
    const loader = createSidebarRendererLoader(importModule);
    const Renderer = lazy(loader.load, { export: "Renderer" });
    const Boundary = loader.Boundary;
    const view = mountSolid(() => {
      const [open, setOpen] = createSignal(true);
      return (
        <>
          <input aria-label="Sibling draft" />
          <Show when={open()}>
            <section role="dialog" aria-label="Popup">
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
              <Boundary>
                <Renderer />
              </Boundary>
            </section>
          </Show>
        </>
      );
    });
    const popup = view.getByRole("dialog");
    const draft = view.getByRole<HTMLInputElement>("textbox");
    draft.value = "retained draft";

    await expect(loader.load()).rejects.toThrow("offline chunk");
    flush();
    expect(view.queryByRole("button", { name: "Loaded action" })).toBeNull();
    expect(view.getByRole("button", { name: "Close" })).toBeTruthy();

    if (retry === "idle") {
      expect(idle).toBeDefined();
      idle?.({ didTimeout: false, timeRemaining: () => 50 });
    } else {
      window.dispatchEvent(new Event("online"));
    }
    await waitForSolid(() =>
      expect(view.getByRole("button", { name: "Loaded action" })).toBeTruthy(),
    );
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(view.getByRole("dialog")).toBe(popup);
    expect(view.getByRole("textbox")).toBe(draft);
    expect(draft.value).toBe("retained draft");
    view.getByRole("button", { name: "Close" }).click();
    flush();
    expect(view.queryByRole("dialog")).toBeNull();
    loader.dispose();
  },
);
