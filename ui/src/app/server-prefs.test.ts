/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  extractServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

describe("extractServerUiPrefs", () => {
  it("keeps only valid, known pref values", () => {
    expect(
      extractServerUiPrefs(
        configWithPrefs({
          theme: "knot",
          themeMode: "dark",
          textScale: 125,
          locale: "de",
          chatShowThinking: false,
          chatSendShortcut: "modifier-enter",
          bogus: true,
        }),
      ),
    ).toEqual({
      theme: "knot",
      themeMode: "dark",
      textScale: 125,
      locale: "de",
      chatShowThinking: false,
      chatSendShortcut: "modifier-enter",
    });
    expect(
      extractServerUiPrefs(configWithPrefs({ theme: "neon", textScale: 97, locale: "xx-YY" })),
    ).toEqual({});
    expect(extractServerUiPrefs({})).toEqual({});
    expect(extractServerUiPrefs(null)).toEqual({});
  });
});

describe("applyServerUiPrefs", () => {
  it("applies a server delta to the local mirror once", () => {
    const onApplied = vi.fn();
    const config = configWithPrefs({ themeMode: "dark", textScale: 110 });

    expect(applyServerUiPrefs(config, { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("dark");
    expect(loadSettings().textScale).toBe(110);
    expect(onApplied).toHaveBeenCalledWith({ themeMode: "dark", textScale: 110 });

    // The same server value never re-applies, so a later local edit sticks.
    patchSettings({ themeMode: "light" });
    expect(applyServerUiPrefs(config, { onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("applies again when the server value actually changes", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "dark" }), { onApplied });
    patchSettings({ themeMode: "light" });

    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("system");
  });

  it("ignores a server custom theme until this browser imported one", () => {
    const onApplied = vi.fn();
    expect(applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied })).toBe(false);
    expect(loadSettings().theme).toBe("claw");
  });
});

describe("changedServerUiPrefs", () => {
  it("returns only the synced keys that changed", () => {
    const previous = loadSettings();
    const next = { ...previous, themeMode: "dark" as const, navCollapsed: !previous.navCollapsed };
    expect(changedServerUiPrefs(previous, next)).toEqual({ themeMode: "dark" });
    expect(changedServerUiPrefs(previous, { ...previous })).toBeNull();
  });
});

describe("pushServerUiPrefs", () => {
  it("patches config with the current hash and folds the push into last-seen", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-1",
        raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
        note: "control-ui prefs sync",
      });
    });

    // A stale snapshot carrying the pre-push value must not revert the change.
    const onApplied = vi.fn();
    patchSettings({ themeMode: "dark" });
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "dark" }), { onApplied })).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("retries once on a hash conflict and gives up silently otherwise", async () => {
    let patchCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: `hash-${patchCalls}` };
      }
      patchCalls += 1;
      if (patchCalls === 1) {
        throw new Error("config baseHash mismatch");
      }
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { textScale: 125 });
    await vi.waitFor(() => {
      expect(patchCalls).toBe(2);
    });
  });
});
