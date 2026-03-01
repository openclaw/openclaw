import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpModule from "./cdp.js";
import * as chromeModule from "./chrome.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as pwAiModule from "./pw-ai-module.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext } from "./server-context.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeState(
  profile: "remote" | "openclaw",
): BrowserServerState & { profiles: Map<string, { lastTargetId?: string | null }> } {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: profile === "remote" ? "https" : "http",
      cdpHost: profile === "remote" ? "browserless.example" : "127.0.0.1",
      cdpIsLoopback: profile !== "remote",
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      evaluateEnabled: false,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: profile,
      profiles: {
        remote: {
          cdpUrl: "https://browserless.example/chrome?token=abc",
          cdpPort: 443,
          color: "#00AA00",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

function makeUnexpectedFetchMock() {
  return vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
}

function createRemoteRouteHarness(fetchMock?: ReturnType<typeof vi.fn>) {
  const activeFetchMock = fetchMock ?? makeUnexpectedFetchMock();
  global.fetch = withFetchPreconnect(activeFetchMock);
  const state = makeState("remote");
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { state, remote: ctx.forProfile("remote"), fetchMock: activeFetchMock };
}

function createSequentialPageLister<T>(responses: T[]) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("no more responses");
    }
    return next;
  });
}

type JsonListEntry = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: "page";
};

function createJsonListFetchMock(entries: JsonListEntry[]) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (!u.includes("/json/list")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return {
      ok: true,
      json: async () => entries,
    } as unknown as Response;
  });
}

describe("browser server-context remote profile tab operations", () => {
  it("uses profile-level attachOnly when global attachOnly is false", async () => {
    const state = makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const reachableMock = vi.mocked(chromeModule.isChromeReachable).mockResolvedValueOnce(false);
    const launchMock = vi.mocked(chromeModule.launchOpenClawChrome);
    const ctx = createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled/i,
    );
    expect(reachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("keeps attachOnly websocket failures off the loopback ownership error path", async () => {
    const state = makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const httpReachableMock = vi.mocked(chromeModule.isChromeReachable).mockResolvedValueOnce(true);
    const wsReachableMock = vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValueOnce(false);
    const launchMock = vi.mocked(chromeModule.launchOpenClawChrome);
    const ctx = createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled and CDP websocket/i,
    );
    expect(httpReachableMock).toHaveBeenCalled();
    expect(wsReachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("uses Playwright tab operations when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T2",
      title: "Tab 2",
      url: "http://127.0.0.1:3000",
      type: "page",
    }));
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);

    const opened = await remote.openTab("http://127.0.0.1:3000");
    expect(opened.targetId).toBe("T2");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      url: "http://127.0.0.1:3000",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers lastTargetId for remote profiles when targetId is omitted", async () => {
    const responses = [
      // ensureTabAvailable() calls listTabs twice
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      // second ensureTabAvailable() calls listTabs twice, order flips
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
    ];

    const listPagesViaPlaywright = vi.fn(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("no more responses");
      }
      return next;
    });

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("falls back to the only tab for remote profiles when targetId is stale", async () => {
    const responses = [
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
    ];
    const listPagesViaPlaywright = createSequentialPageLister(responses);

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();
    const chosen = await remote.ensureTabAvailable("STALE_TARGET");
    expect(chosen.targetId).toBe("T1");
  });

  it("keeps rejecting stale targetId for remote profiles when multiple tabs exist", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
    ];
    const listPagesViaPlaywright = createSequentialPageLister(responses);

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = createRemoteRouteHarness();

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = createRemoteRouteHarness();

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to /json/list when Playwright is not available", async () => {
    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue(null);

    const fetchMock = createJsonListFetchMock([
      {
        id: "T1",
        title: "Tab 1",
        url: "https://example.com",
        webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
        type: "page",
      },
    ]);

    const { remote } = createRemoteRouteHarness(fetchMock);

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not enforce managed tab cap for remote openclaw profiles", async () => {
    const listPagesViaPlaywright = vi
      .fn()
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
        { targetId: "T2", title: "2", url: "https://2.example", type: "page" },
        { targetId: "T3", title: "3", url: "https://3.example", type: "page" },
        { targetId: "T4", title: "4", url: "https://4.example", type: "page" },
        { targetId: "T5", title: "5", url: "https://5.example", type: "page" },
        { targetId: "T6", title: "6", url: "https://6.example", type: "page" },
        { targetId: "T7", title: "7", url: "https://7.example", type: "page" },
        { targetId: "T8", title: "8", url: "https://8.example", type: "page" },
        { targetId: "T9", title: "9", url: "https://9.example", type: "page" },
      ]);

    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://1.example",
      type: "page",
    }));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { remote } = createRemoteRouteHarness(fetchMock);
    const opened = await remote.openTab("https://1.example");
    expect(opened.targetId).toBe("T1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("browser server-context tab selection state", () => {
  it("updates lastTargetId when openTab is created via CDP", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    const fetchMock = createJsonListFetchMock([
      {
        id: "CREATED",
        title: "New Tab",
        url: "http://127.0.0.1:8080",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
        type: "page",
      },
    ]);

    global.fetch = withFetchPreconnect(fetchMock);

    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:8080");
    expect(opened.targetId).toBe("CREATED");
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "http://127.0.0.1:8080",
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("closes excess managed tabs after opening a new tab", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    const existingTabs = [
      {
        id: "OLD1",
        title: "1",
        url: "http://127.0.0.1:3001",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD1",
        type: "page",
      },
      {
        id: "OLD2",
        title: "2",
        url: "http://127.0.0.1:3002",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD2",
        type: "page",
      },
      {
        id: "OLD3",
        title: "3",
        url: "http://127.0.0.1:3003",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD3",
        type: "page",
      },
      {
        id: "OLD4",
        title: "4",
        url: "http://127.0.0.1:3004",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD4",
        type: "page",
      },
      {
        id: "OLD5",
        title: "5",
        url: "http://127.0.0.1:3005",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD5",
        type: "page",
      },
      {
        id: "OLD6",
        title: "6",
        url: "http://127.0.0.1:3006",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD6",
        type: "page",
      },
      {
        id: "OLD7",
        title: "7",
        url: "http://127.0.0.1:3007",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD7",
        type: "page",
      },
      {
        id: "OLD8",
        title: "8",
        url: "http://127.0.0.1:3008",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD8",
        type: "page",
      },
      {
        id: "NEW",
        title: "9",
        url: "http://127.0.0.1:3009",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
        type: "page",
      },
    ];

    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return { ok: true, json: async () => existingTabs } as unknown as Response;
      }
      if (value.includes("/json/close/OLD1")) {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    (state.profiles as Map<string, unknown>).set("openclaw", {
      profile: { name: "openclaw" },
      running: { pid: 1234, proc: { on: vi.fn() } },
      lastTargetId: null,
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/json/close/OLD1"),
      expect.any(Object),
    );
  });

  it("does not fail tab open when managed-tab cleanup list fails", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        listCount += 1;
        if (listCount === 1) {
          return {
            ok: true,
            json: async () => [
              {
                id: "NEW",
                title: "New Tab",
                url: "http://127.0.0.1:3009",
                webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
                type: "page",
              },
            ],
          } as unknown as Response;
        }
        throw new Error("/json/list timeout");
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    (state.profiles as Map<string, unknown>).set("openclaw", {
      profile: { name: "openclaw" },
      running: { pid: 1234, proc: { on: vi.fn() } },
      lastTargetId: null,
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
  });

  it("does not run managed tab cleanup in attachOnly mode", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    const existingTabs = [
      {
        id: "OLD1",
        title: "1",
        url: "http://127.0.0.1:3001",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD1",
        type: "page",
      },
      {
        id: "OLD2",
        title: "2",
        url: "http://127.0.0.1:3002",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD2",
        type: "page",
      },
      {
        id: "OLD3",
        title: "3",
        url: "http://127.0.0.1:3003",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD3",
        type: "page",
      },
      {
        id: "OLD4",
        title: "4",
        url: "http://127.0.0.1:3004",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD4",
        type: "page",
      },
      {
        id: "OLD5",
        title: "5",
        url: "http://127.0.0.1:3005",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD5",
        type: "page",
      },
      {
        id: "OLD6",
        title: "6",
        url: "http://127.0.0.1:3006",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD6",
        type: "page",
      },
      {
        id: "OLD7",
        title: "7",
        url: "http://127.0.0.1:3007",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD7",
        type: "page",
      },
      {
        id: "OLD8",
        title: "8",
        url: "http://127.0.0.1:3008",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD8",
        type: "page",
      },
      {
        id: "NEW",
        title: "9",
        url: "http://127.0.0.1:3009",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
        type: "page",
      },
    ];

    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return { ok: true, json: async () => existingTabs } as unknown as Response;
      }
      if (value.includes("/json/close/")) {
        throw new Error("should not close tabs in attachOnly mode");
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.attachOnly = true;
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/json/close/"),
      expect.anything(),
    );
  });

  it("does not block openTab on slow best-effort cleanup closes", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    const existingTabs = [
      {
        id: "OLD1",
        title: "1",
        url: "http://127.0.0.1:3001",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD1",
        type: "page",
      },
      {
        id: "OLD2",
        title: "2",
        url: "http://127.0.0.1:3002",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD2",
        type: "page",
      },
      {
        id: "OLD3",
        title: "3",
        url: "http://127.0.0.1:3003",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD3",
        type: "page",
      },
      {
        id: "OLD4",
        title: "4",
        url: "http://127.0.0.1:3004",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD4",
        type: "page",
      },
      {
        id: "OLD5",
        title: "5",
        url: "http://127.0.0.1:3005",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD5",
        type: "page",
      },
      {
        id: "OLD6",
        title: "6",
        url: "http://127.0.0.1:3006",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD6",
        type: "page",
      },
      {
        id: "OLD7",
        title: "7",
        url: "http://127.0.0.1:3007",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD7",
        type: "page",
      },
      {
        id: "OLD8",
        title: "8",
        url: "http://127.0.0.1:3008",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OLD8",
        type: "page",
      },
      {
        id: "NEW",
        title: "9",
        url: "http://127.0.0.1:3009",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
        type: "page",
      },
    ];

    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return { ok: true, json: async () => existingTabs } as unknown as Response;
      }
      if (value.includes("/json/close/OLD1")) {
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    (state.profiles as Map<string, unknown>).set("openclaw", {
      profile: { name: "openclaw" },
      running: { pid: 1234, proc: { on: vi.fn() } },
      lastTargetId: null,
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await Promise.race([
      openclaw.openTab("http://127.0.0.1:3009"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("openTab timed out waiting for cleanup")), 300),
      ),
    ]);

    expect(opened.targetId).toBe("NEW");
  });

  it("blocks unsupported non-network URLs before any HTTP tab-open fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.openTab("file:///etc/passwd")).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
