import { describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserProfile } from "../config.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type {
  BrowserRequest,
  BrowserResponse,
  BrowserRouteHandler,
  BrowserRouteRegistrar,
} from "./types.js";

function makeProfile(overrides: Partial<ResolvedBrowserProfile>): ResolvedBrowserProfile {
  return {
    name: "remote",
    cdpPort: 443,
    cdpUrl: "wss://connect.browser-use.com",
    cdpHost: "connect.browser-use.com",
    cdpIsLoopback: false,
    color: "#00AA00",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
  };
}

function makeProfileContext(overrides: Partial<ProfileContext> = {}): ProfileContext {
  return {
    profile: makeProfile({}),
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    isHttpReachable: vi.fn(async () => false),
    isReachable: vi.fn(async () => false),
    listTabs: vi.fn(async () => []),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "/tmp/profile" })),
    ...overrides,
  };
}

function createRegistrar() {
  const routes = new Map<string, BrowserRouteHandler>();
  const registrar: BrowserRouteRegistrar = {
    get: (path, handler) => void routes.set(`GET ${path}`, handler),
    post: (path, handler) => void routes.set(`POST ${path}`, handler),
    delete: (path, handler) => void routes.set(`DELETE ${path}`, handler),
  };
  return { routes, registrar };
}

function makeResponse() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
  const res: BrowserResponse = {
    status: (code) => {
      result.statusCode = code;
      return res;
    },
    json: (body) => {
      result.body = body;
    },
  };
  return { res, result };
}

function makeContext(profileCtx: ProfileContext): BrowserRouteContext {
  return {
    state: vi.fn(),
    forProfile: vi.fn(() => profileCtx),
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(() => null),
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    isHttpReachable: vi.fn(async () => false),
    isReachable: vi.fn(async () => false),
    listTabs: vi.fn(async () => []),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "/tmp/profile" })),
  };
}

describe("browser tab routes", () => {
  it("lists tabs for remote websocket profiles without requiring a cached connection", async () => {
    const listTabs = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const profileCtx = makeProfileContext({ listTabs });
    const ctx = makeContext(profileCtx);
    const { routes, registrar } = createRegistrar();
    registerBrowserTabRoutes(registrar, ctx);

    const handler = routes.get("GET /tabs");
    expect(handler).toBeTypeOf("function");

    const { res, result } = makeResponse();
    await handler!(
      {
        params: {},
        query: {},
      } satisfies BrowserRequest,
      res,
    );

    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({
      running: true,
      tabs: [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
    });
  });

  it("focuses tabs for remote websocket profiles without the browser-not-running preflight", async () => {
    const focusTab = vi.fn(async () => {});
    const listTabs = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const profileCtx = makeProfileContext({ listTabs, focusTab });
    const ctx = makeContext(profileCtx);
    const { routes, registrar } = createRegistrar();
    registerBrowserTabRoutes(registrar, ctx);

    const handler = routes.get("POST /tabs/focus");
    expect(handler).toBeTypeOf("function");

    const { res, result } = makeResponse();
    await handler!(
      {
        params: {},
        query: {},
        body: { targetId: "T1" },
      } satisfies BrowserRequest,
      res,
    );

    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(focusTab).toHaveBeenCalledWith("T1");
    expect(result.body).toEqual({ ok: true });
  });

  it("lists tabs via action=list for remote websocket profiles without requiring a cached connection", async () => {
    const listTabs = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const profileCtx = makeProfileContext({ listTabs });
    const ctx = makeContext(profileCtx);
    const { routes, registrar } = createRegistrar();
    registerBrowserTabRoutes(registrar, ctx);

    const handler = routes.get("POST /tabs/action");
    expect(handler).toBeTypeOf("function");

    const { res, result } = makeResponse();
    await handler!(
      {
        params: {},
        query: {},
        body: { action: "list" },
      } satisfies BrowserRequest,
      res,
    );

    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({
      ok: true,
      tabs: [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
    });
  });
});
