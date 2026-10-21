import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ThemeMode } from "../app/theme.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { ThemeModeToggle } from "./theme-mode-toggle.tsx";

describe("theme mode toggle", () => {
  it("cycles one button through every mode", async () => {
    const [mode, setMode] = createSignal<ThemeMode>("system");
    const modes: ThemeMode[] = [];
    const view = mountSolid(() =>
      createComponent(ThemeModeToggle, {
        get mode() {
          return mode();
        },
        onChange: (next) => {
          modes.push(next);
          setMode(next);
        },
      }),
    );
    const toggle = view.container;

    try {
      flush();
      expect(mode()).toBe("system");
      expect(toggle.querySelectorAll("button")).toHaveLength(1);
      expect(toggle.querySelector("button")?.getAttribute("aria-label")).toBe("Color mode: System");

      for (const expected of ["light", "dark", "system"] satisfies ThemeMode[]) {
        toggle.querySelector<HTMLButtonElement>("button")?.click();
        flush();
        expect(mode()).toBe(expected);
        expect(toggle.querySelectorAll("button")).toHaveLength(1);
      }

      expect(modes).toEqual(["light", "dark", "system"]);
      expect(toggle.querySelector("button")?.getAttribute("aria-label")).toBe("Color mode: System");
    } finally {
      view.unmount();
    }
  });
});
