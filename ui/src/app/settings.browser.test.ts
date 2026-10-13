import { expect, it } from "vitest";
import {
  loadSettings,
  normalizeChatMessageMaxWidth,
  saveSettings,
  settingsKeyForGateway,
} from "./settings.ts";

it("normalizes and persists browser-local chat message width", () => {
  const stored = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!] as const);
  try {
    const settings = loadSettings();
    const scopedKey = settingsKeyForGateway(settings.gatewayUrl);

    expect(normalizeChatMessageMaxWidth("  min(1280px,   82%)  ")).toBe("min(1280px, 82%)");
    expect(normalizeChatMessageMaxWidth("960px; color: red")).toBeUndefined();

    saveSettings({ ...settings, chatMessageMaxWidth: "  min(1280px,   82%)  " });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatMessageMaxWidth).toBe(
      "min(1280px, 82%)",
    );
    expect(loadSettings().chatMessageMaxWidth).toBe("min(1280px, 82%)");

    saveSettings({ ...loadSettings(), chatMessageMaxWidth: undefined });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatMessageMaxWidth",
    );
  } finally {
    localStorage.clear();
    for (const [key, value] of stored) {
      localStorage.setItem(key, value);
    }
  }
});

it("persists and resets the browser-local terminal font without changing text faces", () => {
  const initial = loadSettings();
  try {
    saveSettings({ ...initial, terminalFontFamily: "  FiraCode Nerd Font Mono  " });
    expect(loadSettings().terminalFontFamily).toBe("FiraCode Nerd Font Mono");
    expect(loadSettings().fontUi).toBe(initial.fontUi);
    expect(loadSettings().fontChat).toBe(initial.fontChat);
    saveSettings({ ...loadSettings(), terminalFontFamily: undefined });
    expect(loadSettings().terminalFontFamily).toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem(settingsKeyForGateway(initial.gatewayUrl)) ?? "{}"),
    ).not.toHaveProperty("terminalFontFamily");
  } finally {
    saveSettings(initial);
  }
});

it.each(["none", "48rem"])("preserves supported message width %s", (value) => {
  expect(normalizeChatMessageMaxWidth(value)).toBe(value);
});

it.each(["calc(100%-2rem)", "10cm", "fit-content"])(
  "rejects unsupported message width %s",
  (value) => {
    expect(normalizeChatMessageMaxWidth(value)).toBeUndefined();
  },
);
