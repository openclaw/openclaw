// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { openSlot } from "../pages/chat/sidebar-layout.ts";
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
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

function readStored(gatewayUrl = expectedGatewayUrl("")): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(`openclaw.control.settings.v1:${gatewayUrl}`) ?? "{}");
}

function writeStored(value: Record<string, unknown>, gatewayUrl = expectedGatewayUrl("")) {
  localStorage.setItem(`openclaw.control.settings.v1:${gatewayUrl}`, JSON.stringify(value));
}

describe("resolveApplicationStartupSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a cached shared token when the native dashboard selects browser identity", () => {
    const gatewayUrl = "wss://gateway.example";
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token: null };
    const startup = resolveApplicationStartupSettings(
      makeUiSettings(gatewayUrl, { token: "shared-owner-token" }),
      { pathname: "/chat", search: "", hash: "" },
    );
    expect(startup).toMatchObject({ settings: { gatewayUrl, token: "" }, password: null });
  });

  it("strips fragment bootstrap tokens without persisting them", () => {
    const startup = resolveApplicationStartupSettings(makeUiSettings("wss://gateway.example"), {
      pathname: "/",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway.example&bootstrapToken=boot-123&bootstrapProfile=owner",
    });
    expect(startup.pendingGatewayUrl).toBeNull();
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-123");
    expect(startup.pendingBootstrapProfile).toBe("owner");
    expect(startup.settings.token).toBe("");
    expect(startup.location).toEqual({ pathname: "/", search: "", hash: "" });
  });

  it("carries fragment bootstrap tokens with changed gateway URLs", () => {
    const startup = resolveApplicationStartupSettings(makeUiSettings("wss://gateway-a.example"), {
      pathname: "/dash",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway-b.example&bootstrapToken=boot-456",
    });
    expect(startup.pendingGatewayUrl).toBe("wss://gateway-b.example");
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-456");
    expect(startup.pendingBootstrapProfile).toBeNull();
    expect(startup.location).toEqual({ pathname: "/dash", search: "", hash: "" });
  });

  it("re-scopes the selected token when native auth changes only the Gateway and password", () => {
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: "wss://gateway-b.example",
      password: "next-password",
    };
    const initial = makeUiSettings("wss://gateway-a.example", { token: "old-token" });
    const startup = resolveApplicationStartupSettings(initial, {
      pathname: "/",
      search: "",
      hash: "",
    });
    expect(startup.settings.token).toBe("");
    expect(startup.password).toBe("next-password");
  });

  it("carries a bounded native client identity into gateway startup", () => {
    Object.assign(window, {
      __OPENCLAW_NATIVE_CONTROL_AUTH__: {
        gatewayUrl: "wss://gateway.example",
        client: {
          id: "openclaw-ios",
          mode: "ui",
          platform: "iOS 27.0.0",
          deviceFamily: "iPhone",
          instanceId: "ios-installation",
          scopes: ["operator.read", "operator.write"],
        },
      },
    });
    const startup = resolveApplicationStartupSettings(makeUiSettings("wss://gateway.example"), {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    expect(startup.nativeClient).toEqual({
      clientName: "openclaw-ios",
      mode: "ui",
      platform: "iOS 27.0.0",
      deviceFamily: "iPhone",
      instanceId: "ios-installation",
      scopes: ["operator.read", "operator.write"],
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

  it("keeps development credentials scoped to the upstream when the Vite target changes", () => {
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

  it("binds standalone documents to the page Gateway without persisting a selection", () => {
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

  it("clears the current-tab token explicitly", () => {
    const gwUrl = expectedGatewayUrl("");
    persistSessionToken(gwUrl, "stale-token");
    expect(loadSettings().token).toBe("stale-token");
    persistSessionToken(gwUrl, "");
    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
  });

  it("isolates remembered sessions and selected agents across inferred base paths", () => {
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

  it("persists and parses a chat split layout", () => {
    const chatSplitLayout = {
      columns: [
        { id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] },
        { id: "c2", panes: [{ id: "p2", sessionKey: "agent:main:work" }], paneWeights: [1] },
      ],
      columnWeights: [0.4, 0.6],
      activePaneId: "p2",
    };
    saveSettings({ ...loadSettings(), chatSplitLayout });
    expect(loadSettings().chatSplitLayout).toEqual(chatSplitLayout);
  });

  it("round-trips per-session dashboard tabs and docks while dropping legacy face", () => {
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
    saveSettings(loadSettings());
    expect(loadSettings().boardSessionViews).toEqual(boardSessionViews);
  });

  it("normalizes and round-trips per-session sidebar layouts", () => {
    const valid = openSlot({ columns: [] }, "discussion");
    writeStored({ sidebarSessionLayouts: { main: valid, corrupt: { columns: "invalid" } } });
    const expected = {
      main: valid,
      corrupt: { columns: [], open: false, expanded: false },
    };
    expect(loadSettings().sidebarSessionLayouts).toMatchObject(expected);
    saveSettings(loadSettings());
    expect(loadSettings().sidebarSessionLayouts).toMatchObject(expected);
  });

  it.each([
    [" Research ", "research"],
    [null, null],
  ])(
    "normalizes remembered team scope %j without conflating all agents and unset",
    (value, expected) => {
      writeStored({ sidebarPreTeamScope: value });
      const settings = loadSettings();
      expect(settings.sidebarPreTeamScope).toBe(expected);
      saveSettings(settings);
      expect(loadSettings().sidebarPreTeamScope).toBe(expected);
      expect(Object.hasOwn(readStored(), "sidebarPreTeamScope")).toBe(expected !== undefined);
    },
  );

  it("persists rail shortcuts across save and load, normalizing bad values", () => {
    const gwUrl = expectedGatewayUrl("");
    saveSettings(
      makeUiSettings(gwUrl, {
        sidebarEntries: ["route:tasks", "route:cron"],
        textScale: 100,
        navCollapsed: true,
      }),
    );
    expect(loadSettings().sidebarEntries).toEqual(["route:cron"]);
    expect(readStored().railShortcuts).toEqual(["route:tasks", "route:cron"]);
    expect(readStored()).not.toHaveProperty("sidebarEntries");
    expect(loadSettings().navWidth).toBe(258);
    expect(readStored()).not.toHaveProperty("navCollapsed");

    // Corrupt the persisted list; load falls back to the empty rail.
    writeStored({
      ...readStored(),
      railShortcuts: "route:tasks",
      navWidth: 220,
      navCollapsed: true,
    });
    expect(loadSettings().sidebarEntries).toEqual([]);
    expect(loadSettings().navWidth).toBe(258);
    expect(loadSettings().navCollapsed).toBe(false);
  });

  it.each(["direct save", "unrelated locale patch"])(
    "keeps legacy sidebar order and pins out of rail shortcuts through %s",
    (action) => {
      const gatewayUrl = expectedGatewayUrl("");
      const sessionsByGateway = {
        [gatewayUrl]: { sessionKey: "agent:main:work", lastActiveSessionKey: "agent:main:work" },
      };
      const sidebarEntries = ["route:chat", "route:activity", "route:usage", "route:cron"];
      const sidebarPinnedRoutes = ["workboard", "usage", "tasks", "usage", "worktrees", 7];
      writeStored({
        gatewayUrl,
        theme: "claw",
        themeMode: "dark",
        navWidth: 300,
        sessionsByGateway,
        sidebarEntries,
        sidebarPinnedRoutes,
      });
      if (action === "unrelated locale patch") {
        patchSettings({ locale: "de" });
      }
      const settings = loadSettings();
      expect(settings).toMatchObject({
        gatewayUrl,
        sessionKey: "agent:main:work",
        lastActiveSessionKey: "agent:main:work",
        themeMode: "dark",
        navWidth: 300,
      });
      expect(settings.sidebarEntries).toEqual([]);
      saveSettings(settings);
      expect(readStored().sessionsByGateway).toEqual(sessionsByGateway);
      expect(readStored()).toMatchObject({
        sidebarEntries,
        sidebarPinnedRoutes,
        railShortcuts: [],
      });
      expect(loadSettings()).toEqual(settings);
    },
  );

  it("persists roster mode and defaults invalid stored modes to chip", () => {
    saveSettings({ ...loadSettings(), sidebarAgentsMode: "roster" });
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    writeStored({ sidebarAgentsMode: "invalid" });
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
  });

  it("preserves an older browser-panel preference through external opt-in, reload, and opt-out", () => {
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

  it("publishes profile readiness only when requested", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const initial = loadSettings();
    const { gateway } = createGatewayStoreTestStore({ settings: initial });
    const theme = createApplicationTheme(initial, gateway);
    theme.refresh();
    const listener = vi.fn();
    theme.subscribe(listener);
    try {
      theme.refresh();
      expect(listener).not.toHaveBeenCalled();
      theme.refresh({ notify: true });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      theme.dispose();
      gateway.stop();
    }
  });

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

      const background = selectBackgroundSource({ kind: "none" });
      saveBackgroundPreference(first.gatewayUrl, background);
      events.dispatchEvent(
        Object.assign(new Event("storage"), {
          key: backgroundPreferenceStorageKey(first.gatewayUrl),
        }),
      );
      expect(theme.settings.background).toEqual(background);
      saveBackgroundPreference(second.gatewayUrl, selectBackgroundSource({ kind: "theme" }));
      events.dispatchEvent(
        Object.assign(new Event("storage"), {
          key: backgroundPreferenceStorageKey(second.gatewayUrl),
        }),
      );
      expect(theme.settings.background).toEqual(background);
      expect(credentialReads).not.toHaveBeenCalled();

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
  ])(
    "normalizes local user identity independently from Gateway settings: %j",
    (stored, expected) => {
      localStorage.setItem("openclaw.control.user.v1", JSON.stringify(stored));
      expect(loadLocalUserIdentity()).toEqual(expected);
    },
  );

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

  it("round-trips explicit camera intent and rejects invalid stored values", () => {
    for (const talkCameraAutoEnable of [true, false]) {
      saveSettings({ ...loadSettings(), talkCameraAutoEnable });
      expect(readStored().talkCameraAutoEnable).toBe(talkCameraAutoEnable);
      expect(loadSettings().talkCameraAutoEnable).toBe(talkCameraAutoEnable);
    }
    writeStored({ talkCameraAutoEnable: "true" });
    expect(loadSettings().talkCameraAutoEnable).toBeUndefined();
  });

  it("persists pinned agents and normalizes duplicate or malformed entries", () => {
    saveSettings({ ...loadSettings(), pinnedAgentIds: ["main", "research"] });
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
    writeStored({ pinnedAgentIds: ["main", "main", 7, "  ", " research "] });
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
  });

  it("keeps the latest created agent scoped to its Gateway", () => {
    const firstGateway = "wss://first.example";
    const secondGateway = "wss://second.example";
    patchSettings(
      { gatewayUrl: firstGateway, sidebarRecentlyCreatedAgentId: "bot-first" },
      {
        selectGateway: false,
      },
    );
    patchSettings(
      { gatewayUrl: secondGateway, sidebarRecentlyCreatedAgentId: "bot-second" },
      {
        selectGateway: false,
      },
    );
    expect(loadSettings(firstGateway).sidebarRecentlyCreatedAgentId).toBe("bot-first");
    expect(loadSettings(secondGateway).sidebarRecentlyCreatedAgentId).toBe("bot-second");
    writeStored({ sidebarRecentlyCreatedAgentId: 7 }, firstGateway);
    expect(loadSettings(firstGateway).sidebarRecentlyCreatedAgentId).toBeUndefined();
  });
});
