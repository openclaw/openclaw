/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectMcpAppStyleVariables } from "../components/mcp-app-theme.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  document.querySelectorAll('[id^="openclaw-theme-palette-"]').forEach((link) => link.remove());
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

function setup() {
  const previous = loadSettings();
  saveSettings({ ...previous, theme: "claw", themeMode: "light" });
  disposals.push(() => saveSettings(previous));
  const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
  disposals.push(() => gateway.stop());
  const theme = createApplicationTheme(loadSettings(), gateway);
  disposals.push(() => theme.dispose());
  const snapshots = vi.fn(() => ({
    theme: theme.settings.theme,
    mode: document.documentElement.dataset.themeMode,
    variables: collectMcpAppStyleVariables(),
  }));
  theme.subscribe(snapshots);
  return { theme, snapshots };
}

function pendingPalette() {
  const link = document.getElementById("openclaw-theme-palette-tide");
  expect(link).toBeInstanceOf(HTMLLinkElement);
  return link!;
}

describe("applied theme palette publication", () => {
  it.each(["synchronous", "load", "error"])(
    "publishes the applied palette with %s completion without a branding change",
    (event) => {
      const { snapshots } = setup();
      const mascot = document.documentElement.dataset.themeMascot;
      document.documentElement.style.setProperty("--card", "#ffffff");
      patchSettings({ theme: event === "synchronous" ? "claw" : "tide", themeMode: "dark" });
      expect(snapshots).toHaveBeenCalledOnce();
      if (event === "synchronous") {
        expect(snapshots).toHaveLastReturnedWith(expect.objectContaining({ mode: "dark" }));
        return;
      }
      expect(snapshots).toHaveNthReturnedWith(
        1,
        expect.objectContaining({
          theme: "tide",
          mode: "light",
          variables: expect.objectContaining({ "--color-background-primary": "#ffffff" }),
        }),
      );
      // The browser installs the stylesheet before delivering its load event.
      document.documentElement.style.setProperty("--card", "#16202b");
      if (event === "error") {
        vi.spyOn(console, "error").mockImplementation(() => {});
      }
      pendingPalette().dispatchEvent(new Event(event));
      expect(document.documentElement.dataset.themeMascot).toBe(mascot);
      expect(snapshots).toHaveBeenCalledTimes(2);
      expect(snapshots).toHaveNthReturnedWith(
        2,
        expect.objectContaining({
          theme: "tide",
          mode: "dark",
          variables: expect.objectContaining({ "--color-background-primary": "#16202b" }),
        }),
      );
    },
  );

  it.each(["superseded", "disposed"])("ignores a %s palette completion", (state) => {
    const { theme, snapshots } = setup();
    patchSettings({ theme: "tide", themeMode: "dark" });
    const link = pendingPalette();
    if (state === "disposed") {
      theme.dispose();
    } else {
      patchSettings({ theme: "claw", themeMode: "light" });
    }
    snapshots.mockClear();
    link.dispatchEvent(new Event("load"));
    expect(snapshots).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.themeMode).toBe("light");
  });
});
