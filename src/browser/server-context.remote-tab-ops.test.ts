import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import * as cdpModule from "./cdp.js";
import * as pwAiModule from "./pw-ai-module.js";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
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

describe("browser server-context remote profile tab operations", () => {
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
      navigationChecked: true,
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

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => [
          {
            id: "T1",
            title: "Tab 1",
            url: "https://example.com",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    const { remote } = createRemoteRouteHarness(fetchMock);

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("browser server-context tab selection state", () => {
  it("updates lastTargetId when openTab is created via CDP", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => [
          {
            id: "CREATED",
            title: "New Tab",
            url: "http://127.0.0.1:8080",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

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
      navigationChecked: true,
    });
  });
});
