import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
import { createBrowserRouteContext } from "./server-context.js";

function makeBrowserState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome",
      profiles: {
        chrome: {
          driver: "extension",
          cdpUrl: "http://127.0.0.1:18792",
          cdpPort: 18792,
          color: "#00AA00",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

function stubExtensionRelayFetch(opts: {
  lists: unknown[];
  aliases?: Record<string, string>;
  activated?: string[];
  closed?: string[];
}) {
  const queue = [...opts.lists];
  const aliases = opts.aliases ?? {};
  const activated = opts.activated ?? [];
  const closed = opts.closed ?? [];
  const fetchMock = vi.fn(async (url: unknown) => {
    const raw = String(url);
    if (raw.includes("/json/list")) {
      const next = queue.shift();
      if (!next) {
        throw new Error("no more /json/list responses");
      }
      return { ok: true, json: async () => next } as unknown as Response;
    }
    const resolveMatch = raw.match(/\/json\/resolve\/([^/?#]+)/);
    if (resolveMatch) {
      const requested = decodeURIComponent(resolveMatch[1] ?? "");
      const mapped = aliases[requested];
      if (!mapped) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ targetId: mapped }) } as unknown as Response;
    }
    const activateMatch = raw.match(/\/json\/activate\/([^/?#]+)/);
    if (activateMatch) {
      activated.push(decodeURIComponent(activateMatch[1] ?? ""));
      return { ok: true, text: async () => "OK" } as unknown as Response;
    }
    const closeMatch = raw.match(/\/json\/close\/([^/?#]+)/);
    if (closeMatch) {
      closed.push(decodeURIComponent(closeMatch[1] ?? ""));
      return { ok: true, text: async () => "OK" } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${raw}`);
  });

  global.fetch = withFetchPreconnect(fetchMock);
  return { fetchMock, activated, closed };
}

describe("browser server-context ensureTabAvailable extension target aliases", () => {
  it("resolves stale target ids via relay alias endpoint", async () => {
    stubExtensionRelayFetch({
      lists: [
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
          {
            id: "tab-C",
            type: "page",
            url: "https://other.example",
            webSocketDebuggerUrl: "ws://x/c",
          },
        ],
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
          {
            id: "tab-C",
            type: "page",
            url: "https://other.example",
            webSocketDebuggerUrl: "ws://x/c",
          },
        ],
      ],
      aliases: { "stale-A": "fresh-B" },
    });
    const state = makeBrowserState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    const chosen = await ctx.forProfile("chrome").ensureTabAvailable("stale-A");
    expect(chosen.targetId).toBe("fresh-B");
  });

  it("keeps focus continuity for stale ids after redirect target swap", async () => {
    const { activated } = stubExtensionRelayFetch({
      lists: [
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
        ],
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
        ],
      ],
      aliases: { "stale-A": "fresh-B" },
    });
    const state = makeBrowserState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    await ctx.forProfile("chrome").focusTab("stale-A");
    expect(activated).toEqual(["fresh-B"]);
  });

  it("keeps close continuity for stale ids after redirect target swap", async () => {
    const { closed } = stubExtensionRelayFetch({
      lists: [
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
        ],
        [
          {
            id: "fresh-B",
            type: "page",
            url: "https://login.example",
            webSocketDebuggerUrl: "ws://x/b",
          },
        ],
      ],
      aliases: { "stale-A": "fresh-B" },
    });
    const state = makeBrowserState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    await ctx.forProfile("chrome").closeTab("stale-A");
    expect(closed).toEqual(["fresh-B"]);
  });
});
