// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSlot } from "../pages/chat/sidebar-layout.ts";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setControlUiBasePath,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
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
    expect(startup.settings.gatewayUrl).toBe(gatewayUrl);
    expect(startup.settings.token).toBe("");
    expect(startup.password).toBeNull();
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
  });

  it("keeps development credentials scoped to the upstream when the Vite target changes", () => {
    setTestLocation({ protocol: "http:", host: "localhost:5173", pathname: "/" });
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
    // The Vite marker selects the development gateway port.
    vi.stubGlobal("document", {
      querySelector: (selector: string) => (selector.includes("@vite/client") ? {} : null),
      documentElement: { getAttribute: () => null },
    });

    try {
      expect(loadSettings().gatewayUrl).toBe("ws://[::1]:18789");
    } finally {
      // Drop the document before the shared persistence cleanup.
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
    visit("gateway-a");
    expect(loadSettings().gatewayUrl).toBe("ws://multi.example:8443/gateway-a");
    saveSettings(
      makeUiSettings("wss://remote-a.example", {
        sessionKey: "agent:a:main",
        lastActiveSessionKey: "agent:a:main",
        selectedAgentId: " A ",
      }),
    );
    visit("gateway-b");
    expect(loadSettings().gatewayUrl).toBe("ws://multi.example:8443/gateway-b");
    saveSettings(
      makeUiSettings("wss://remote-b.example", {
        sessionKey: "agent:b:main",
        lastActiveSessionKey: "agent:b:main",
        selectedAgentId: " B ",
      }),
    );
    visit("gateway-a");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-a.example",
      sessionKey: "agent:a:main",
      lastActiveSessionKey: "agent:a:main",
      selectedAgentId: "a",
    });
    expect(loadGatewaySessionSelection("wss://remote-a.example")).toEqual({
      sessionKey: "agent:a:main",
      lastActiveSessionKey: "agent:a:main",
      selectedAgentId: "a",
    });
    visit("gateway-b");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-b.example",
      sessionKey: "agent:b:main",
      lastActiveSessionKey: "agent:b:main",
      selectedAgentId: "b",
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
    expect(loadSettings().sidebarSessionLayouts).toMatchObject({
      main: valid,
      corrupt: { columns: [], open: false, expanded: false },
    });
    saveSettings(loadSettings());
    expect(loadSettings().sidebarSessionLayouts).toMatchObject({
      main: valid,
      corrupt: { columns: [], open: false, expanded: false },
    });
  });

  it.each([
    [" Research ", "research"],
    [null, null],
    [true, undefined],
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

  it("persists sidebar width without leaking tab-local visibility across reloads", () => {
    saveSettings({ ...loadSettings(), navCollapsed: true, navWidth: 320 });
    const persisted = readStored();
    expect(persisted).not.toHaveProperty("navCollapsed");
    expect(persisted.navWidth).toBe(320);
    expect(loadSettings()).toMatchObject({ navCollapsed: false, navWidth: 320 });

    writeStored({ ...persisted, navCollapsed: true });
    expect(loadSettings()).toMatchObject({ navCollapsed: false, navWidth: 320 });
  });

  it("persists sidebar entries across save and load, normalizing bad values", () => {
    const gwUrl = expectedGatewayUrl("");
    saveSettings(
      makeUiSettings(gwUrl, {
        sidebarEntries: ["route:tasks", "route:cron"],
        textScale: 100,
      }),
    );
    expect(loadSettings().sidebarEntries).toEqual(["route:cron"]);
    expect(loadSettings().navWidth).toBe(258);

    // Corrupt the persisted list; load falls back to the default pinned set.
    writeStored({ ...readStored(), sidebarEntries: "route:tasks", navWidth: 220 });
    expect(loadSettings().sidebarEntries).toEqual([
      "route:agents-home",
      "route:dashboards",
      "route:systems",
      "route:cron",
      "route:plugins",
    ]);
    expect(loadSettings().navWidth).toBe(258);
  });

  it.each([
    ["2026.7.1-beta.1", {}],
    ["2026.7.1", { sidebarPinnedRoutes: ["workboard", "usage", "tasks", "usage", "worktrees", 7] }],
  ])("loads and upgrades settings written by %s", (_release, sidebar) => {
    const gatewayUrl = expectedGatewayUrl("");
    // Both July writers persisted sessionsByGateway; the stable release added pinned routes.
    const sessionsByGateway = {
      [gatewayUrl]: { sessionKey: "agent:main:work", lastActiveSessionKey: "agent:main:work" },
    };
    writeStored({
      gatewayUrl,
      theme: "claw",
      themeMode: "dark",
      navWidth: 300,
      sessionsByGateway,
      ...sidebar,
    });
    const settings = loadSettings();
    expect(settings).toMatchObject({
      gatewayUrl,
      sessionKey: "agent:main:work",
      lastActiveSessionKey: "agent:main:work",
      themeMode: "dark",
      navWidth: 300,
    });
    if ("sidebarPinnedRoutes" in sidebar) {
      expect(settings.sidebarEntries).toEqual(["plugin:workboard/workboard", "route:usage"]);
      expect(readStored().sidebarEntries).toEqual(settings.sidebarEntries);
    }
    saveSettings(settings);
    expect(readStored().sessionsByGateway).toEqual(sessionsByGateway);
    expect(readStored()).not.toHaveProperty("sidebarPinnedRoutes");
    expect(loadSettings()).toEqual(settings);
  });

  it("persists roster mode and defaults invalid stored modes to chip", () => {
    saveSettings({ ...loadSettings(), sidebarAgentsMode: "roster" });
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    writeStored({ sidebarAgentsMode: "invalid" });
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
  });
});
