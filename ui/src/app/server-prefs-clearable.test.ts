/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { extractServerUiPrefs } from "./server-prefs-state.ts";
import { configWithPrefs } from "./server-prefs.test-support.ts";
import { applyServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, setSettingsChangeListener } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  setSettingsChangeListener(null);
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("clearable pref removal from the server", () => {
  it("clears the local follow-up override when the server removes it", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ chatFollowUpMode: "queue" }), { onApplied });
    expect(loadSettings().chatFollowUpMode).toBe("queue");

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().chatFollowUpMode).toBeUndefined();
  });

  it("clears the local locale override when the server removes it", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ locale: "de" }), { onApplied });
    expect(loadSettings().locale).toBe("de");

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().locale).toBeUndefined();
    expect(onApplied).toHaveBeenLastCalledWith({ locale: undefined });
  });

  it("restores product defaults when authored synced values are removed", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(
      configWithPrefs({
        theme: "knot",
        themeMode: "dark",
        accent: "#48d6c2",
        chatSendShortcut: "modifier-enter",
      }),
      { onApplied },
    );

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    const reset = loadSettings();
    expect(reset).toMatchObject({
      theme: "claw",
      themeMode: "system",
    });
    expect(reset.accent).toBeUndefined();
    expect(reset.chatSendShortcut).toBe("enter");
    const persisted = JSON.parse(
      localStorage.getItem(`openclaw.control.settings.v1:${reset.gatewayUrl}`) ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "accent")).toBe(false);
    expect(Object.hasOwn(persisted, "chatSendShortcut")).toBe(false);
  });
});

describe("agent order synced preference", () => {
  it("normalizes saved IDs, applies explicit order and server reset", () => {
    const onApplied = vi.fn();
    expect(
      extractServerUiPrefs(configWithPrefs({ sidebarAgentOrder: ["work", "work", "", "missing"] })),
    ).toEqual({ sidebarAgentOrder: ["work", "missing"] });
    applyServerUiPrefs(configWithPrefs({ sidebarAgentOrder: ["work", "missing"] }), { onApplied });
    expect(loadSettings().sidebarAgentOrder).toEqual(["work", "missing"]);
    applyServerUiPrefs(configWithPrefs({ sidebarAgentOrder: [] }), { onApplied });
    expect(loadSettings().sidebarAgentOrder).toEqual([]);
    const previous = loadSettings();
    expect(changedServerUiPrefs(previous, { ...previous, sidebarAgentOrder: ["work"] })).toEqual({
      sidebarAgentOrder: ["work"],
    });
  });

  it("clears a cached order when the server removes the preference key", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ sidebarAgentOrder: ["work", "main"] }), { onApplied });
    expect(loadSettings().sidebarAgentOrder).toEqual(["work", "main"]);

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().sidebarAgentOrder).toEqual([]);
    expect(onApplied).toHaveBeenLastCalledWith({ sidebarAgentOrder: [] });
  });
});
