// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import {
  applyServerUiPrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import {
  loadLocalUserIdentity,
  patchSettings,
  persistSessionToken,
  loadSettings,
  loadUiPreferences,
  saveSettings,
} from "./settings.ts";

describe("settings preference persistence", () => {
  installSettingsStorageLifecycle();
  beforeEach(() => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
  });

  it("preserves an older browser-panel preference through external opt-in, reload, and opt-out", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const gatewayUrl = "wss://gateway.example";
    const storageKey = "openclaw.control.settings.v1:" + gatewayUrl;
    // Pre-change browser settings have no external-link field.
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        gatewayUrl,
        openLinksInControlUiBrowser: true,
        navWidth: 312,
      }),
    );
    expect(loadSettings().openLinksExternally).not.toBe(true);
    for (const enabled of [true, false]) {
      patchSettings({ openLinksExternally: enabled });
      const reloaded = loadUiPreferences(gatewayUrl);
      expect(reloaded.openLinksExternally === true).toBe(enabled);
      expect(reloaded.openLinksInControlUiBrowser).toBe(true);
      expect(reloaded.navWidth).toBe(312);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
        openLinksInControlUiBrowser: true,
        navWidth: 312,
      });
    }
    expect(loadUiPreferences("wss://other.example").openLinksExternally).not.toBe(true);
  });

  it.each([false, true])(
    "keeps the live connection URL when a same-scope spelling was persisted (private storage: %s)",
    (privateStorage) => {
      setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
      if (privateStorage) {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new Error("Storage unavailable");
        });
      }
      saveSettings({
        ...loadSettings(),
        gatewayUrl: "wss://gateway.example/control/",
        realtimeTalkInputDeviceId: "scoped-mic",
      });
      expect(loadUiPreferences("wss://gateway.example/control")).toMatchObject({
        gatewayUrl: "wss://gateway.example/control",
        realtimeTalkInputDeviceId: "scoped-mic",
      });
    },
  );

  it("keeps live preferences scoped through cross-tab edits, gateway switches, and credential rotation", async () => {
    setTestLocation({ protocol: "https:", host: "gateway-a.example", pathname: "/" });
    const events = new EventTarget();
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const first = {
      ...loadSettings(),
      realtimeTalkInputDeviceId: "mic-a",
      chatSendShortcut: "modifier-enter" as const,
    };
    const second = {
      ...first,
      gatewayUrl: "wss://gateway-b.example",
      realtimeTalkInputDeviceId: "mic-b",
      chatSendShortcut: "enter" as const,
    };
    saveSettings(first);
    saveSettings(second);
    const { gateway } = createGatewayStoreTestStore({ settings: first });
    const theme = createApplicationTheme(first, gateway);
    try {
      resetServerUiPrefsSync();
      const key = `openclaw.control.settings.v1:${first.gatewayUrl}`;
      const next = {
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        realtimeTalkInputDeviceId: "cross-tab-mic",
      };
      localStorage.setItem(key, JSON.stringify(next));
      const credentialReads = vi.spyOn(sessionStorage, "getItem");
      events.dispatchEvent(Object.assign(new Event("storage"), { key }));
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("cross-tab-mic");
      expect(credentialReads).not.toHaveBeenCalled();
      expect(theme.settings).not.toHaveProperty("token");

      const selectionKey = `openclaw.control.currentGateway.v1:${first.gatewayUrl}`;
      localStorage.setItem(selectionKey, second.gatewayUrl);
      events.dispatchEvent(Object.assign(new Event("storage"), { key: selectionKey }));
      expect.soft(loadSettings().gatewayUrl).toBe(first.gatewayUrl);
      expect
        .soft(resolveServerUiPrefState({}, "chatSendShortcut", first.gatewayUrl).value)
        .toBe("modifier-enter");
      expect
        .soft(
          applyServerUiPrefs(
            { ui: { prefs: { chatSendShortcut: "enter" } } },
            {
              scope: first.gatewayUrl,
              onApplied: vi.fn(),
            },
          ),
        )
        .toBe(true);
      expect.soft(theme.settings.chatSendShortcut).toBe("enter");
      patchSettings({ chatSendShortcut: "modifier-enter" });
      expect(theme.settings.chatSendShortcut).toBe("modifier-enter");
      patchSettings({ chatSendShortcut: "enter" });
      expect(theme.settings.gatewayUrl).toBe(first.gatewayUrl);
      expect(JSON.parse(localStorage.getItem(key) ?? "{}").realtimeTalkInputDeviceId).toBe(
        "cross-tab-mic",
      );
      gateway.connect({ gatewayUrl: second.gatewayUrl });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("mic-b");
      gateway.connect({ gatewayUrl: first.gatewayUrl });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("cross-tab-mic");
      expect(theme.settings.chatSendShortcut).toBe("enter");

      persistSessionToken(first.gatewayUrl, "synthetic-rotated-credential");
      credentialReads.mockClear();
      patchSettings({ composerHoldToRecord: false });
      expect(credentialReads.mock.calls.map(([readKey]) => readKey)).toEqual([
        `openclaw.control.token.v1:${first.gatewayUrl}`,
      ]);
      expect(theme.settings.composerHoldToRecord).toBe(false);
      expect(JSON.parse(localStorage.getItem(key) ?? "{}")).not.toHaveProperty("token");
      expect(loadSettings().token).toBe("synthetic-rotated-credential");
    } finally {
      resetServerUiPrefsSync();
      theme.dispose();
      gateway.stop();
      await vi.dynamicImportSettled();
    }
  });

  it("retains live private-storage edits and releases the mounted preference owner", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const initial = loadSettings();
    const { gateway } = createGatewayStoreTestStore({ settings: initial });
    const theme = createApplicationTheme(initial, gateway);
    try {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      patchSettings({ realtimeTalkInputDeviceId: "private-mic" });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
      const reads = vi.spyOn(sessionStorage, "getItem");
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
      expect(reads).not.toHaveBeenCalled();
      theme.dispose();
      patchSettings({ realtimeTalkInputDeviceId: "after-dispose" });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
    } finally {
      theme.dispose();
      gateway.stop();
    }
  });

  it("normalizes persisted text scale to the nearest supported stop", () => {
    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        textScale: 123,
      }),
    );
    expect(loadSettings().textScale).toBe(125);
  });

  it("persists the browser-local custom theme payload when present", () => {
    const gwUrl = expectedGatewayUrl("");
    const customTheme = createImportedCustomThemeFixture();
    saveSettings(makeUiSettings(gwUrl, { theme: "custom", customTheme }));
    const settings = loadSettings();
    expect(settings.theme).toBe("custom");
    expect(settings.customTheme?.label).toBe("Light Green");
    expect(settings.customTheme?.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
  });

  it("loads local user identity separately from gateway settings", () => {
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({ name: "Buns", avatar: "🦞" }),
    );
    expect(loadLocalUserIdentity()).toEqual({ name: "Buns", avatar: "🦞" });
  });

  it("rejects invalid local user identity values on load", () => {
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({
        name: "  ",
        avatar: "https://example.com/avatar.png",
      }),
    );
    expect(loadLocalUserIdentity()).toEqual({ name: null, avatar: null });
  });

  it("falls back to claw when persisted custom theme palettes are invalid", () => {
    localStorage.setItem(
      `openclaw.control.settings.v1:${expectedGatewayUrl("")}`,
      JSON.stringify({
        theme: "custom",
        themeMode: "dark",
        customTheme: {
          ...createImportedCustomThemeFixture(),
          light: {},
          dark: {},
        },
      }),
    );
    expect(loadSettings()).toMatchObject({ theme: "claw", themeMode: "dark" });
  });

  it("round-trips explicit camera intent and rejects invalid stored values", () => {
    const key = `openclaw.control.settings.v1:${expectedGatewayUrl("")}`;
    for (const talkCameraAutoEnable of [true, false]) {
      saveSettings({ ...loadSettings(), talkCameraAutoEnable });
      expect(JSON.parse(localStorage.getItem(key) ?? "{}").talkCameraAutoEnable).toBe(
        talkCameraAutoEnable,
      );
      expect(loadSettings().talkCameraAutoEnable).toBe(talkCameraAutoEnable);
    }
    localStorage.setItem(key, JSON.stringify({ talkCameraAutoEnable: "true" }));
    expect(loadSettings().talkCameraAutoEnable).toBeUndefined();
  });

  it("persists pinned agents and normalizes duplicate or malformed entries", () => {
    const key = `openclaw.control.settings.v1:${expectedGatewayUrl("")}`;
    saveSettings({ ...loadSettings(), pinnedAgentIds: ["main", "research"] });
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
    localStorage.setItem(
      key,
      JSON.stringify({ pinnedAgentIds: ["main", "main", 7, "  ", " research "] }),
    );
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
  });
});
