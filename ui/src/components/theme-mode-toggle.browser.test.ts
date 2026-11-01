import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ThemeMode } from "../app/theme.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderSidebarIdentityMenu } from "./app-sidebar-identity-menu.tsx";

describe("theme mode toggle", () => {
  it("cycles one button through every mode", async () => {
    const [mode, setMode] = createSignal<ThemeMode>("system");
    const modes: ThemeMode[] = [];
    const view = mountSolid(() =>
      renderSidebarIdentityMenu({
        position: { x: 16, bottom: 16, width: 250 },
        nativeGatewaySnapshot: null,
        canPairDevice: true,
        basePath: "",
        gatewayVersion: "test",
        updateAvailable: false,
        canRetryConnection: false,
        triggerWidth: 250,
        onClose() {},
        onNavigate() {},
        onPairMobile() {},
        get themeMode() {
          return mode();
        },
        onThemeChange: (next) => {
          modes.push(next);
          setMode(next);
        },
      }),
    );

    try {
      flush();
      const toggle = view.container.querySelector("openclaw-theme-mode-toggle")!;
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
