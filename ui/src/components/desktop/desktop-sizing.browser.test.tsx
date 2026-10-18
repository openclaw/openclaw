import { createSignal, untrack } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DesktopSizingMode } from "./desktop-client.ts";
import { DesktopSizing } from "./desktop-panel-view.tsx";

describe.runIf("__vitest_browser__" in globalThis)("pending desktop sizing selection", () => {
  it.each(["select", "menu"] as const)(
    "cancels retained Match through %s before authentication completes",
    async (presentation) => {
      const { userEvent } = await import("vitest/browser");
      const [mode, setMode] = createSignal<DesktopSizingMode>("match");
      const [canResize, setCanResize] = createSignal(true);
      const onChange = vi.fn((next: DesktopSizingMode) => setMode(next));
      const view = mountSolid(() => (
        <DesktopSizing
          mode={mode()}
          canResize={canResize()}
          onChange={onChange}
          presentation={presentation === "menu" ? "menu" : undefined}
        />
      ));
      setCanResize(false);
      flush();
      if (presentation === "menu") {
        const trigger = view.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
        expect(trigger.textContent).toContain("Match");
        trigger.focus();
        await userEvent.keyboard("{ArrowDown}");
        const entries = [
          ...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
        ];
        const match = entries.find((entry) => entry.getAttribute("aria-label") === "Match")!;
        expect(match.getAttribute("aria-checked")).toBe("true");
        expect(match.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement?.textContent?.trim()).toBe("Fit");
        await userEvent.keyboard("{Enter}");
        flush();
        expect(onChange).toHaveBeenCalledExactlyOnceWith("fit");
        expect(trigger.textContent).toContain("Fit");
        expect(document.activeElement).toBe(trigger);
        setCanResize(true);
        flush();
        expect(untrack(mode)).toBe("fit");
        return;
      }
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
    },
  );
});
