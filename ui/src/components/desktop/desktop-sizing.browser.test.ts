import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSizingMode } from "./desktop-client.ts";
import { renderDesktopSizing } from "./desktop-panel-view.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("pending desktop sizing selection", () => {
  it("cancels retained Match with a native Fit selection before authentication completes", async () => {
    const { userEvent } = await import("vitest/browser");
    const host = document.createElement("div");
    document.body.append(host);
    let mode: DesktopSizingMode = "match";
    const onChange = vi.fn((next: DesktopSizingMode) => {
      mode = next;
    });
    render(renderDesktopSizing({ mode, canResize: true, onChange }), host);
    render(renderDesktopSizing({ mode, canResize: false, onChange }), host);
    const menu = host.querySelector("select")!;
    const pendingValue = menu.value;
    const pendingDisabled = menu.selectedOptions[0]?.disabled;
    await userEvent.selectOptions(menu, "fit");
    expect({ pendingValue, pendingDisabled, selectedValue: menu.value, mode }).toEqual({
      pendingValue: "match",
      pendingDisabled: true,
      selectedValue: "fit",
      mode: "fit",
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fit");
    render(renderDesktopSizing({ mode, canResize: true, onChange }), host);
    expect(menu.value).toBe("fit");
  });
});
