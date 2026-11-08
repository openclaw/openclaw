import { beforeEach, expect, it } from "vitest";
import { isChatBubbleMode, setChatBubbleMode } from "../pages/chat/chat-bubble-mode.ts";
import { normalizeChatMessageMaxWidth } from "./settings-contract.ts";
import { loadSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";

beforeEach(({ onTestFinished }) => {
  const initial = loadSettings();
  const previous = Object.keys(localStorage).map(
    (key) => [key, localStorage.getItem(key)!] as const,
  );
  onTestFinished(() => {
    saveSettings(initial);
    localStorage.clear();
    for (const [key, value] of previous) {
      localStorage.setItem(key, value);
    }
  });
});

function stored(gatewayUrl = loadSettings().gatewayUrl) {
  return JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}");
}

it.each([false, true])("persists Gateway-scoped bubbles (legacy preferences=%s)", (legacy) => {
  const gatewayUrl = "ws://bubbles.example:18789";
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
  // v2026.10.1 predates bubble preferences.
  if (legacy) {
    localStorage.setItem(settingsKeyForGateway(gatewayUrl), JSON.stringify(preferences));
  }
  const settings = loadSettings(gatewayUrl);
  if (legacy) {
    expect(isChatBubbleMode(settings, "main")).toBe(false);
  }
  const sessions = ["agent:main:main", "agent:main:other"];
  saveSettings({
    ...settings,
    chatBubbleSessionKeys: [" main ", "AGENT:MAIN:MAIN", "agent:main:other"],
  });
  expect(stored(gatewayUrl).chatBubbleSessionKeys).toEqual(sessions);
  expect(isChatBubbleMode(loadSettings(settings.gatewayUrl), "main", true)).toBe(true);
  if (legacy) {
    expect(loadSettings(gatewayUrl)).toMatchObject(preferences);
    expect(stored(gatewayUrl)).toMatchObject(preferences);
  }
  const otherGateway = "ws://other-bubbles.example:18789";
  localStorage.removeItem(settingsKeyForGateway(otherGateway));
  expect(loadSettings(otherGateway).chatBubbleSessionKeys).toBeUndefined();
  saveSettings({ ...loadSettings(otherGateway), chatBubbleSessionKeys: ["agent:main:third"] });
  expect(loadSettings(settings.gatewayUrl).chatBubbleSessionKeys).toEqual(sessions);
  const withoutMain = setChatBubbleMode(loadSettings(settings.gatewayUrl), "main", false);
  const withoutOther = setChatBubbleMode(withoutMain, "agent:main:other", false);
  saveSettings({ ...loadSettings(settings.gatewayUrl), ...withoutOther });
  expect(stored(settings.gatewayUrl)).not.toHaveProperty("chatBubbleSessionKeys");
  expect(loadSettings(settings.gatewayUrl).chatBubbleDisabledSessionKeys).toEqual(sessions);
});

it("persists and resets the browser-local terminal font without changing text faces", () => {
  const initial = loadSettings();
  saveSettings({ ...initial, terminalFontFamily: "  FiraCode Nerd Font Mono  " });
  expect(loadSettings()).toMatchObject({
    terminalFontFamily: "FiraCode Nerd Font Mono",
    fontUi: initial.fontUi,
    fontChat: initial.fontChat,
  });
  saveSettings({ ...loadSettings(), terminalFontFamily: undefined });
  expect(loadSettings().terminalFontFamily).toBeUndefined();
  expect(stored()).not.toHaveProperty("terminalFontFamily");
});

it.each([
  ["none", "none"],
  ["48rem", "48rem"],
  ["960px; color: red", undefined],
  ["10cm", undefined],
  ["fit-content", undefined],
])("normalizes message width %s", (value, expected) => {
  expect(normalizeChatMessageMaxWidth(value)).toBe(expected);
});
