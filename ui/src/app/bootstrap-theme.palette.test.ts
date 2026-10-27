/* @vitest-environment jsdom */

import { createEffect, createRoot, flush } from "@solidjs/signals";
import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { collectMcpAppStyleVariables } from "../components/mcp-app-theme.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

const disposals: Array<() => void> = [];
let theme: ReturnType<typeof createApplicationTheme>;
let snapshots: Mock<() => (string | undefined)[]>;
beforeEach(({ onTestFinished }) => {
  const existingFontLinks = new Set(document.querySelectorAll('link[id^="openclaw-typeface-"]'));
  const previous = loadSettings();
  saveSettings({ ...previous, theme: "claw", themeMode: "light" });
  const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
  theme = createApplicationTheme(loadSettings(), gateway);
  snapshots = vi.fn(() => [
    theme.settings.theme,
    document.documentElement.dataset.themeMode,
    collectMcpAppStyleVariables()["--color-background-primary"],
  ]);
  theme.subscribe(snapshots);
  onTestFinished(() => {
    for (const dispose of disposals.splice(0).toReversed()) {
      dispose();
    }
    theme.dispose();
    gateway.stop();
    saveSettings(previous);
    document.querySelectorAll('[id^="openclaw-theme-palette-"]').forEach((link) => link.remove());
    document.documentElement.removeAttribute("style");
    vi.restoreAllMocks();
    for (const link of document.querySelectorAll('link[id^="openclaw-typeface-"]')) {
      if (!existingFontLinks.has(link)) {
        link.remove();
      }
    }
  });
});

const pendingPalette = () => document.getElementById("openclaw-theme-palette-tide")!;

function observe(read: () => string | undefined) {
  const values: string[] = [];
  createEffect(read, (value) => void values.push(value ?? "none"));
  return values;
}

it("projects immediate preferences separately from the applied palette", () => {
  const projection = projectTheme(theme);
  const { preferences, palettes, dispose } = createRoot((stop) => ({
    preferences: observe(() => projection.preferences.read().theme),
    palettes: observe(() => projection.appliedPalette.read()?.theme),
    dispose: stop,
  }));
  disposals.push(dispose, projection.dispose);
  flush();
  patchSettings({ theme: "tide", themeMode: "dark" });
  flush();
  expect([preferences, palettes]).toEqual([["claw", "tide"], ["claw"]]);
  pendingPalette().dispatchEvent(new Event("load"));
  flush();
  expect([preferences, palettes]).toEqual([
    ["claw", "tide"],
    ["claw", "tide"],
  ]);
  projection.dispose();
  patchSettings({ theme: "claw" });
  flush();
  expect(palettes).toEqual(["claw", "tide"]);
});

it.each(["synchronous", "load", "error"])("publishes %s without rebranding", (event) => {
  const mascot = document.documentElement.dataset.themeMascot;
  document.documentElement.style.setProperty("--card", "#ffffff");
  patchSettings({ theme: event === "synchronous" ? "claw" : "tide", themeMode: "dark" });
  expect(snapshots).toHaveBeenCalledOnce();
  if (event === "synchronous") {
    expect(snapshots).toHaveLastReturnedWith(["claw", "dark", "#ffffff"]);
    return;
  }
  expect(snapshots).toHaveNthReturnedWith(1, ["tide", "light", "#ffffff"]);
  // The browser installs the stylesheet before delivering its load event.
  document.documentElement.style.setProperty("--card", "#16202b");
  if (event === "error") {
    vi.spyOn(console, "error").mockImplementation(() => {});
  }
  pendingPalette().dispatchEvent(new Event(event));
  expect(document.documentElement.dataset.themeMascot).toBe(mascot);
  expect(snapshots).toHaveBeenCalledTimes(2);
  expect(snapshots).toHaveNthReturnedWith(2, ["tide", "dark", "#16202b"]);
});

it.each(["superseded", "disposed"])("ignores a %s palette completion", (state) => {
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
