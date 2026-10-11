import { createSignal, untrack } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DesktopSizingMode } from "./desktop-client.ts";
import { DesktopSizing } from "./desktop-panel-view.tsx";

describe.runIf("__vitest_browser__" in globalThis)("pending desktop sizing selection", () => {
  it("cancels retained Match with a native Fit selection before authentication completes", async () => {
    const { userEvent } = await import("vitest/browser");
    const [mode, setMode] = createSignal<DesktopSizingMode>("match");
    const [canResize, setCanResize] = createSignal(true);
    const onChange = vi.fn((next: DesktopSizingMode) => setMode(next));
    const view = mountSolid(() => (
      <DesktopSizing mode={mode()} canResize={canResize()} onChange={onChange} />
    ));
    setCanResize(false);
    flush();
    const menu = view.container.querySelector("select")!;
    const pendingValue = menu.value;
    const pendingDisabled = menu.selectedOptions[0]?.disabled;
    await userEvent.selectOptions(menu, "fit");
    flush();
    expect({
      pendingValue,
      pendingDisabled,
      selectedValue: menu.value,
      mode: untrack(mode),
    }).toEqual({
      pendingValue: "match",
      pendingDisabled: true,
      selectedValue: "fit",
      mode: "fit",
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fit");
    setCanResize(true);
    flush();
    expect(menu.value).toBe("fit");
  });
});
