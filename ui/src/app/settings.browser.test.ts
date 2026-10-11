import { expect, it } from "vitest";
import { isChatBubbleMode, setChatBubbleMode } from "../pages/chat/chat-bubble-mode.ts";
import {
  loadSettings,
  normalizeChatMessageMaxWidth,
  saveSettings,
  settingsKeyForGateway,
} from "./settings.ts";

it("persists canonical bubble sessions only for their Gateway", () => {
  const stored = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!] as const);
  try {
    const settings = loadSettings();
    const scopedKey = settingsKeyForGateway(settings.gatewayUrl);
    saveSettings({
      ...settings,
      chatBubbleSessionKeys: [" main ", "AGENT:MAIN:MAIN", "agent:main:other"],
    });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatBubbleSessionKeys).toEqual([
      "agent:main:main",
      "agent:main:other",
    ]);
    expect(isChatBubbleMode(loadSettings(settings.gatewayUrl), "main")).toBe(true);
    const otherGateway = "ws://other-bubbles.example:18789";
    localStorage.removeItem(settingsKeyForGateway(otherGateway));
    expect(loadSettings(otherGateway).chatBubbleSessionKeys).toBeUndefined();
    saveSettings({ ...loadSettings(otherGateway), chatBubbleSessionKeys: ["agent:main:third"] });
    expect(loadSettings(settings.gatewayUrl).chatBubbleSessionKeys).toEqual([
      "agent:main:main",
      "agent:main:other",
    ]);
    const withoutMain = setChatBubbleMode(loadSettings(settings.gatewayUrl), "main", false);
    const withoutOther = setChatBubbleMode(withoutMain, "agent:main:other", false);
    saveSettings({ ...loadSettings(settings.gatewayUrl), ...withoutOther });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatBubbleSessionKeys",
    );
  } finally {
    localStorage.clear();
    for (const [key, value] of stored) {
      localStorage.setItem(key, value);
    }
  }
});

it("preserves pre-bubble v1 preferences when opting a session into bubbles", () => {
  const stored = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!] as const);
  try {
    const gatewayUrl = "ws://legacy-bubbles.example:18789";
    // This record uses the persisted fields written by v2026.10.1, before bubbles existed.
    const preferences = {
      gatewayUrl,
      theme: "claw",
      themeMode: "dark",
      chatShowThinking: false,
      chatShowToolCalls: false,
      chatPersistCommentary: false,
      composerHoldToRecord: false,
      navWidth: 300,
      chatMessageMaxWidth: "48rem",
    };
    const key = settingsKeyForGateway(gatewayUrl);
    localStorage.setItem(key, JSON.stringify(preferences));

    const loaded = loadSettings(gatewayUrl);
    expect(loaded).toMatchObject(preferences);
    expect(isChatBubbleMode(loaded, "main")).toBe(false);

    saveSettings({ ...loaded, ...setChatBubbleMode(loaded, "main", true) });
    const reopened = loadSettings(gatewayUrl);
    expect(reopened).toMatchObject(preferences);
    expect(isChatBubbleMode(reopened, "main")).toBe(true);
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toMatchObject({
      ...preferences,
      chatBubbleSessionKeys: ["agent:main:main"],
    });
  } finally {
    localStorage.clear();
    for (const [key, value] of stored) {
      localStorage.setItem(key, value);
    }
  }
});

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
