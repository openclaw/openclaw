/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { dismissChatInputRecoveryKey, loadSettings, saveSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => vi.unstubAllGlobals());

it("merges dismissal keys without overwriting appearance or another Gateway's preferences", () => {
  const a = "ws://recovery-a.test";
  const b = "ws://recovery-b.test";
  saveSettings({ ...loadSettings(a), themeMode: "light" });
  saveSettings({ ...loadSettings(b), themeMode: "dark" });
  expect(dismissChatInputRecoveryKey(a, "viewer-a/session/input-one")).toBe(true);
  expect(dismissChatInputRecoveryKey(a, "viewer-b/session/input-two")).toBe(true);
  expect(loadSettings(a)).toMatchObject({
    themeMode: "light",
    chatInputRecoveryDismissed: ["viewer-a/session/input-one", "viewer-b/session/input-two"],
  });
  expect(loadSettings(b).chatInputRecoveryDismissed).toBeUndefined();
  expect(loadSettings(b).themeMode).toBe("dark");
});

it("bounds opaque dismissal keys and rejects oversized entries", () => {
  const url = "ws://recovery-bound.test";
  saveSettings({
    ...loadSettings(url),
    chatInputRecoveryDismissed: Array.from({ length: 512 }, (_, i) => String(i)),
  });
  expect(dismissChatInputRecoveryKey(url, "new")).toBe(true);
  expect(loadSettings(url).chatInputRecoveryDismissed).toHaveLength(512);
  expect(loadSettings(url).chatInputRecoveryDismissed).not.toContain("0");
  expect(dismissChatInputRecoveryKey(url, "x".repeat(8193))).toBe(false);
});

it("reports unavailable storage instead of claiming a durable dismissal", () => {
  const storage = createStorageMock();
  storage.setItem = () => {
    throw new Error("quota");
  };
  vi.stubGlobal("localStorage", storage);
  expect(dismissChatInputRecoveryKey("ws://recovery-unavailable.test", "opaque-input-key")).toBe(
    false,
  );
  expect(loadSettings("ws://recovery-unavailable.test").chatInputRecoveryDismissed).toEqual([
    "opaque-input-key",
  ]);
});
