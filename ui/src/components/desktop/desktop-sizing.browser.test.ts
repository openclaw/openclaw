import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSizingMode } from "./desktop-client.ts";
import { renderDesktopSizing } from "./desktop-panel-view.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("pending desktop sizing selection", () => {
  it("cancels retained Match with a native Fit selection before authentication completes", async () => {
    const { page, userEvent } = await import("vitest/browser");
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
    const changes: Array<{ value: string; trusted: boolean }> = [];
    menu.addEventListener("change", (event) => {
      changes.push({ value: menu.value, trusted: event.isTrusted });
    });

    // Choosing an already-selected Fit does not emit a native change event.
    await page.getByRole("combobox", { name: "Desktop size", exact: true }).click();
    await userEvent.keyboard("{Home}{Enter}");
    expect({ pendingValue, pendingDisabled, changes, mode }).toEqual({
      pendingValue: "match",
      pendingDisabled: true,
      changes: [{ value: "fit", trusted: true }],
      mode: "fit",
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fit");
    render(renderDesktopSizing({ mode, canResize: true, onChange }), host);
    expect(menu.value).toBe("fit");
  });
});
