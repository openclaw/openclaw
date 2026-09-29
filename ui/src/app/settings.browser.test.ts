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

it.each([
  "none",
  "min-content",
  "max-content",
  "48rem",
  "960px",
  "82%",
  ".5em",
  "80ch",
  "80vw",
  "90vh",
  "30vmin",
  "40vmax",
  "min(1280px, 82%)",
  "max(30rem, 70%)",
  "clamp(400px, 80%, 960px)",
  "calc(100% - 2rem)",
  "min(calc(100% - 2rem), 960px)",
])("preserves supported message width %s", (value) => {
  expect(normalizeChatMessageMaxWidth(value)).toBe(value);
});

it.each([
  "calc(100%-2rem)",
  "clamp(400px, 80%)",
  "960px; color: red",
  "var(--reading-width)",
  "10cm",
  "inherit",
  "fit-content",
])("rejects unsupported message width %s", (value) => {
  expect(normalizeChatMessageMaxWidth(value)).toBeUndefined();
});
