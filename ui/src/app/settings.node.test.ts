// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setControlUiBasePath,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { applyServerUiPrefs, resolveServerUiPrefState } from "./server-prefs-reconcile.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { backgroundPreferenceStorageKey, saveBackgroundPreference } from "./settings-background.ts";
import {
  loadGatewaySessionSelection,
  loadLocalUserIdentity,
  loadSettings,
  loadUiPreferences,
  patchSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

function readStored(gatewayUrl = expectedGatewayUrl("")): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(`openclaw.control.settings.v1:${gatewayUrl}`) ?? "{}");
}

function writeStored(value: Record<string, unknown>, gatewayUrl = expectedGatewayUrl("")) {
  localStorage.setItem(`openclaw.control.settings.v1:${gatewayUrl}`, JSON.stringify(value));
}

function startup(gatewayUrl: string, hash = "", pathname = "/", token = "") {
  return resolveApplicationStartupSettings(makeUiSettings(gatewayUrl, { token }), {
    pathname,
    search: "",
    hash,
  });
}

function roundTrip<K extends keyof UiSettings>(key: K, value: UiSettings[K]) {
  saveSettings({ ...loadSettings(), [key]: value });
  expect(loadSettings()[key]).toEqual(value);
}

const themeCleanups: Array<() => void> = [];
function mountTheme(initial = loadSettings()) {
  const { gateway } = createGatewayStoreTestStore({ settings: initial });
  const theme = createApplicationTheme(initial, gateway);
  themeCleanups.push(() => {
    resetServerUiPrefsSync();
    theme.dispose();
    gateway.stop();
  });
  return { gateway, theme };
}

describe("resolveApplicationStartupSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears shared tokens for native browser identity", () => {
    const gatewayUrl = "wss://gateway.example";
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token: null };
    expect(startup(gatewayUrl, "", "/chat", "shared-owner-token")).toMatchObject({
      settings: { gatewayUrl, token: "" },
      password: null,
    });
  });

  it("carries fragment bootstrap tokens with changed gateway URLs", () => {
    const result = startup(
      "wss://gateway-a.example",
      "#gatewayUrl=wss%3A%2F%2Fgateway-b.example&bootstrapToken=boot-456",
      "/dash",
    );
    expect(result).toMatchObject({
      pendingGatewayUrl: "wss://gateway-b.example",
      pendingGatewayToken: null,
      pendingBootstrapToken: "boot-456",
      pendingBootstrapProfile: null,
    });
    expect(result.location).toEqual({ pathname: "/dash", search: "", hash: "" });
  });

  it("re-scopes tokens when native Gateway and password change", () => {
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: "wss://gateway-b.example",
      password: "next-password",
    };
    expect(startup("wss://gateway-a.example", "", "/", "old-token")).toMatchObject({
      settings: { token: "" },
      password: "next-password",
    });
  });
});

describe("gateway settings and layout persistence", () => {
  installSettingsStorageLifecycle();

  beforeEach(() => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    vi.stubGlobal("matchMedia", (media: string): MediaQueryList => ({
      media,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }));
  });

  it("scopes development credentials to the Vite upstream", () => {
    setTestLocation({ protocol: "http:", host: "localhost:5173", pathname: "/" });
    vi.stubGlobal("OPENCLAW_UI_DEV_SERVER", true);
    const first = "ws://localhost:18789";
    const second = "ws://localhost:18790";
    saveSettings(makeUiSettings(first));
    persistSessionToken(first, "first-credential");
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl: second, proxyPath: "/dev-second" });
    expect(loadSettings()).toMatchObject({ gatewayUrl: second, token: "" });
    persistSessionToken(second, "second-credential");
    expect(loadSettings()).toMatchObject({ gatewayUrl: second, token: "second-credential" });
    expect(resolvePageGatewaySettings(makeUiSettings(first))).toMatchObject({
      gatewayUrl: second,
      token: "second-credential",
    });
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl: first, proxyPath: "/dev-first" });
    expect(loadSettings()).toMatchObject({ gatewayUrl: first, token: "first-credential" });
  });

  it("keeps IPv6 dev-page default gateway hosts dialable", () => {
    setTestLocation({ protocol: "http:", host: "[::1]:5173", pathname: "/" });
    vi.stubGlobal("OPENCLAW_UI_DEV_SERVER", true);

    try {
      expect(loadSettings().gatewayUrl).toBe("ws://[::1]:18789");
    } finally {
      // Drop the development fact before the shared persistence cleanup.
      vi.unstubAllGlobals();
    }
  });

  it("keeps remote-ingress pages on their serving Gateway during development", () => {
    vi.stubGlobal("OPENCLAW_UI_DEV_SERVER", true);
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
      gatewayUrl: "wss://other.example",
      proxyPath: "/dev-other",
    });
    vi.stubGlobal("document", {
      documentElement: {
        getAttribute: (name: string) => (name === "data-openclaw-remote-ingress" ? "true" : null),
      },
    });

    try {
      expect(loadSettings().gatewayUrl).toBe("wss://gateway.example:8443");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("binds standalone pages without persisting a selection", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/openclaw/approve/exec%3A1",
    });
    setControlUiBasePath("/openclaw");
    const remote = makeUiSettings("wss://remote.example:8443", {
      sessionKey: "agent:remote:main",
      lastActiveSessionKey: "agent:remote:main",
    });
    const sessionCredential = ["page", "session", "credential"].join("-");
    persistSessionToken(expectedGatewayUrl("/openclaw"), sessionCredential);
    const before = [...Array(localStorage.length)].map((_, index) => localStorage.key(index));
    expect(resolvePageGatewaySettings(remote)).toMatchObject({
      gatewayUrl: expectedGatewayUrl("/openclaw"),
      token: sessionCredential,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual(
      before,
    );
  });

  it("isolates sessions and agents across inferred base paths", () => {
    function visit(base: string) {
      setTestLocation({ protocol: "http:", host: "multi.example:8443", pathname: `/${base}/chat` });
    }
    const selection = (id: string) => ({
      sessionKey: `agent:${id}:main`,
      lastActiveSessionKey: `agent:${id}:main`,
      selectedAgentId: id,
    });
    for (const id of ["a", "b"]) {
      visit(`gateway-${id}`);
      expect(loadSettings().gatewayUrl).toBe(`ws://multi.example:8443/gateway-${id}`);
      saveSettings(
        makeUiSettings(`wss://remote-${id}.example`, {
          ...selection(id),
          selectedAgentId: ` ${id.toUpperCase()} `,
        }),
      );
    }
    for (const id of ["a", "b"]) {
      visit(`gateway-${id}`);
      expect(loadSettings()).toMatchObject({
        gatewayUrl: `wss://remote-${id}.example`,
        ...selection(id),
      });
    }
    expect(loadGatewaySessionSelection("wss://remote-a.example")).toEqual({
      sessionKey: "agent:a:main",
      lastActiveSessionKey: "agent:a:main",
      selectedAgentId: "a",
    });
  });

  it("round-trips dashboard tabs and docks, dropping legacy face", () => {
    const boardSessionViews = {
      main: { activeTabId: "research", reopenDockByTab: { research: "left" } },
      legacy: { activeTabId: "notes" },
    };
    writeStored({
      boardSessionViews: {
        ...boardSessionViews,
        legacy: { ...boardSessionViews.legacy, face: "grid" },
      },
    });
    expect(loadSettings().boardSessionViews).toEqual(boardSessionViews);
    roundTrip("boardSessionViews", boardSessionViews);
  });

  it.each([
    [" Research ", "research"],
    [null, null],
  ])("normalizes team scope %j without losing explicit null", (value, expected) => {
    writeStored({ sidebarPreTeamScope: value });
    const settings = loadSettings();
    expect(settings.sidebarPreTeamScope).toBe(expected);
    saveSettings(settings);
    expect(loadSettings().sidebarPreTeamScope).toBe(expected);
    expect(Object.hasOwn(readStored(), "sidebarPreTeamScope")).toBe(expected !== undefined);
  });

  it("persists rail shortcuts across save and load, normalizing bad values", () => {
    saveSettings({
      ...loadSettings(),
      sidebarEntries: ["route:tasks", "route:cron"],
      navCollapsed: true,
    });
    expect(loadSettings().sidebarEntries).toEqual(["route:cron"]);
    expect(readStored().railShortcuts).toEqual(["route:tasks", "route:cron"]);
    expect(readStored()).not.toHaveProperty("sidebarEntries");
    expect(loadSettings().navWidth).toBe(258);
    expect(readStored()).not.toHaveProperty("navCollapsed");

    writeStored({
      ...readStored(),
      railShortcuts: "route:tasks",
      navWidth: 220,
      navCollapsed: true,
    });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: [],
      navWidth: 258,
      navCollapsed: false,
    });
  });

  it.each(["direct save", "unrelated locale patch"])(
    "preserves legacy sidebar data outside rail shortcuts: %s",
    (action) => {
      const sidebarEntries = ["route:chat", "route:cron"];
      const sidebarPinnedRoutes = ["usage", "usage", 7];
      writeStored({ sidebarEntries, sidebarPinnedRoutes });
      if (action === "unrelated locale patch") {
        patchSettings({ locale: "de" });
      }
      const settings = loadSettings();
      expect(settings.sidebarEntries).toEqual([]);
      saveSettings(settings);
      expect(readStored()).toMatchObject({
        sidebarEntries,
        sidebarPinnedRoutes,
        railShortcuts: [],
      });
      expect(loadSettings()).toEqual(settings);
    },
  );

  it("persists roster mode and defaults invalid stored modes to chip", () => {
    roundTrip("sidebarAgentsMode", "roster");
    writeStored({ sidebarAgentsMode: "invalid" });
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
  });

  it("preserves browser-panel settings across external-link toggles", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const gatewayUrl = "wss://gateway.example";
    // Pre-change browser settings have no external-link field.
    const retained = { openLinksInControlUiBrowser: true, navWidth: 312 };
    writeStored({ gatewayUrl, ...retained }, gatewayUrl);
    expect(loadSettings().openLinksExternally).not.toBe(true);
    for (const enabled of [true, false]) {
      patchSettings({ openLinksExternally: enabled });
      const reloaded = loadUiPreferences(gatewayUrl);
      expect(reloaded.openLinksExternally === true).toBe(enabled);
      expect(reloaded).toMatchObject(retained);
      expect(readStored(gatewayUrl)).toMatchObject(retained);
    }
    expect(loadUiPreferences("wss://other.example").openLinksExternally).not.toBe(true);
  });

  describe("mounted preferences", () => {
    afterEach(async () => {
      for (const dispose of themeCleanups.splice(0)) {
        dispose();
      }
      await vi.dynamicImportSettled();
    });

    it("publishes profile readiness only when requested", () => {
      setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
      const { theme } = mountTheme();
      theme.refresh();
      const listener = vi.fn();
      theme.subscribe(listener);
      theme.refresh();
      expect(listener).not.toHaveBeenCalled();
      theme.refresh({ notify: true });
      expect(listener).toHaveBeenCalledOnce();
    });

    it("scopes live preferences across tabs, Gateways and token rotation", async () => {
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
      const { gateway, theme } = mountTheme(first);
      const dispatchStorage = (key: string) =>
        events.dispatchEvent(Object.assign(new Event("storage"), { key }));
      resetServerUiPrefsSync();
      const key = `openclaw.control.settings.v1:${first.gatewayUrl}`;
      writeStored(
        { ...readStored(first.gatewayUrl), realtimeTalkInputDeviceId: "cross-tab-mic" },
        first.gatewayUrl,
      );
      const credentialReads = vi.spyOn(sessionStorage, "getItem");
      dispatchStorage(key);
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("cross-tab-mic");
      expect(credentialReads).not.toHaveBeenCalled();
      expect(theme.settings).not.toHaveProperty("token");

      const background = selectBackgroundSource({ kind: "none" });
      saveBackgroundPreference(first.gatewayUrl, background);
      dispatchStorage(backgroundPreferenceStorageKey(first.gatewayUrl));
      expect(theme.settings.background).toEqual(background);
      saveBackgroundPreference(second.gatewayUrl, selectBackgroundSource({ kind: "theme" }));
      dispatchStorage(backgroundPreferenceStorageKey(second.gatewayUrl));
      expect(theme.settings.background).toEqual(background);
      expect(credentialReads).not.toHaveBeenCalled();

      const selectionKey = `openclaw.control.currentGateway.v1:${first.gatewayUrl}`;
      localStorage.setItem(selectionKey, second.gatewayUrl);
      dispatchStorage(selectionKey);
      expect.soft(loadSettings().gatewayUrl).toBe(first.gatewayUrl);
      expect
        .soft(resolveServerUiPrefState({}, "chatSendShortcut", first.gatewayUrl).value)
        .toBe("modifier-enter");
      const serverPrefs = { ui: { prefs: { chatSendShortcut: "enter" } } };
      const hooks = { scope: first.gatewayUrl, onApplied: vi.fn() };
      expect.soft(applyServerUiPrefs(serverPrefs, hooks)).toBe(true);
      expect.soft(theme.settings.chatSendShortcut).toBe("enter");
      patchSettings({ chatSendShortcut: "modifier-enter" });
      expect(theme.settings.chatSendShortcut).toBe("modifier-enter");
      patchSettings({ chatSendShortcut: "enter" });
      expect(theme.settings.gatewayUrl).toBe(first.gatewayUrl);
      expect(readStored(first.gatewayUrl).realtimeTalkInputDeviceId).toBe("cross-tab-mic");
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
      expect(readStored(first.gatewayUrl)).not.toHaveProperty("token");
      expect(loadSettings().token).toBe("synthetic-rotated-credential");
    });

    it("retains private-storage edits until owner disposal", () => {
      setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
      const { theme } = mountTheme();
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
    });
  });

  it("normalizes persisted text scale to the nearest supported stop", () => {
    writeStored({ gatewayUrl: expectedGatewayUrl(""), textScale: 123 });
    expect(loadSettings().textScale).toBe(125);
  });

  it.each([
    [
      { name: "Buns", avatar: "🦞" },
      { name: "Buns", avatar: "🦞" },
    ],
    [
      { name: "  ", avatar: "https://example.com/avatar.png" },
      { name: null, avatar: null },
    ],
  ])("normalizes Gateway-independent user identity: %j", (stored, expected) => {
    localStorage.setItem("openclaw.control.user.v1", JSON.stringify(stored));
    expect(loadLocalUserIdentity()).toEqual(expected);
  });

  it("falls back to claw when persisted custom theme palettes are invalid", () => {
    writeStored({
      theme: "custom",
      themeMode: "dark",
      customTheme: {
        ...createImportedCustomThemeFixture(),
        light: {},
        dark: {},
      },
    });
    expect(loadSettings()).toMatchObject({ theme: "claw", themeMode: "dark" });
  });

  it("rejects non-boolean camera intent", () => {
    writeStored({ talkCameraAutoEnable: "true" });
    expect(loadSettings().talkCameraAutoEnable).toBeUndefined();
  });

  it("persists pinned agents and normalizes duplicate or malformed entries", () => {
    roundTrip("pinnedAgentIds", ["main", "research"]);
    writeStored({ pinnedAgentIds: ["main", "main", 7, "  ", " research "] });
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
  });

  it("keeps the latest created agent scoped to its Gateway", () => {
    const firstGateway = "wss://first.example";
    const secondGateway = "wss://second.example";
    patchSettings(
      { gatewayUrl: firstGateway, sidebarRecentlyCreatedAgentId: "bot-first" },
      { selectGateway: false },
    );
    patchSettings(
      { gatewayUrl: secondGateway, sidebarRecentlyCreatedAgentId: "bot-second" },
      { selectGateway: false },
    );
    expect(loadSettings(firstGateway).sidebarRecentlyCreatedAgentId).toBe("bot-first");
    expect(loadSettings(secondGateway).sidebarRecentlyCreatedAgentId).toBe("bot-second");
    writeStored({ sidebarRecentlyCreatedAgentId: 7 }, firstGateway);
    expect(loadSettings(firstGateway).sidebarRecentlyCreatedAgentId).toBeUndefined();
  });
});
