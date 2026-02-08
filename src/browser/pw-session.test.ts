import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./firefox.js", () => ({
  getFirefoxContext: vi.fn(() => undefined),
}));

import { getFirefoxContext } from "./firefox.js";
import {
  ensurePageState,
  listPagesViaPlaywright,
  createPageViaPlaywright,
  refLocator,
  rememberRoleRefsForTarget,
  restoreRoleRefsForTarget,
} from "./pw-session.js";

function fakePage(): {
  page: Page;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  mocks: {
    on: ReturnType<typeof vi.fn>;
    getByRole: ReturnType<typeof vi.fn>;
    frameLocator: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });
  const getByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameLocator = vi.fn(() => ({
    getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
  }));
  const locator = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));

  const page = {
    on,
    getByRole,
    frameLocator,
    locator,
  } as unknown as Page;

  return { page, handlers, mocks: { on, getByRole, frameLocator, locator } };
}

describe("pw-session refLocator", () => {
  it("uses frameLocator for role refs when snapshot was scoped to a frame", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };
    state.roleRefsFrameSelector = "iframe#main";

    refLocator(page, "e1");

    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });

  it("uses page getByRole for role refs by default", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };

    refLocator(page, "e1");

    expect(mocks.getByRole).toHaveBeenCalled();
  });

  it("uses aria-ref locators when refs mode is aria", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefsMode = "aria";

    refLocator(page, "e1");

    expect(mocks.locator).toHaveBeenCalledWith("aria-ref=e1");
  });
});

describe("pw-session role refs cache", () => {
  it("restores refs for a different Page instance (same CDP targetId)", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    rememberRoleRefsForTarget({
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      frameSelector: "iframe#main",
    });

    const { page, mocks } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page });

    refLocator(page, "e1");
    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });
});

describe("pw-session ensurePageState", () => {
  it("tracks page errors and network requests (best-effort)", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    const req = {
      method: () => "GET",
      url: () => "https://example.com/api",
      resourceType: () => "xhr",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    } as unknown as import("playwright-core").Request;

    const resp = {
      request: () => req,
      status: () => 500,
      ok: () => false,
    } as unknown as import("playwright-core").Response;

    handlers.get("request")?.[0]?.(req);
    handlers.get("response")?.[0]?.(resp);
    handlers.get("requestfailed")?.[0]?.(req);
    handlers.get("pageerror")?.[0]?.(new Error("boom"));

    expect(state.errors.at(-1)?.message).toBe("boom");
    expect(state.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://example.com/api",
      resourceType: "xhr",
      status: 500,
      ok: false,
      failureText: "net::ERR_FAILED",
    });
  });

  it("drops state on page close", () => {
    const { page, handlers } = fakePage();
    const state1 = ensurePageState(page);
    handlers.get("close")?.[0]?.();

    const state2 = ensurePageState(page);
    expect(state2).not.toBe(state1);
    expect(state2.console).toEqual([]);
    expect(state2.errors).toEqual([]);
    expect(state2.requests).toEqual([]);
  });
});

describe("pw-session Firefox synthetic page IDs", () => {
  function fakeFirefoxPage(urlVal = "about:blank", titleVal = ""): Page {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      }),
      url: vi.fn(() => urlVal),
      title: vi.fn(async () => titleVal),
      goto: vi.fn(async () => null),
      getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
      frameLocator: vi.fn(),
      locator: vi.fn(),
    } as unknown as Page;
  }

  it("listPagesViaPlaywright returns empty when Firefox context is missing", async () => {
    vi.mocked(getFirefoxContext).mockReturnValue(undefined);
    const pages = await listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18801",
      engine: "firefox",
      profileName: "ff-test",
    });
    expect(pages).toEqual([]);
  });

  it("listPagesViaPlaywright returns synthetic ff- IDs for Firefox pages", async () => {
    const page1 = fakeFirefoxPage("https://example.com", "Example");
    const page2 = fakeFirefoxPage("https://test.com", "Test");
    const mockContext = {
      pages: vi.fn(() => [page1, page2]),
    } as unknown as BrowserContext;

    vi.mocked(getFirefoxContext).mockReturnValue(mockContext);

    const pages = await listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18801",
      engine: "firefox",
      profileName: "ff-list-test",
    });

    expect(pages).toHaveLength(2);
    expect(pages[0].targetId).toMatch(/^ff-\d+$/);
    expect(pages[0].url).toBe("https://example.com");
    expect(pages[0].title).toBe("Example");
    expect(pages[0].type).toBe("page");
    expect(pages[1].targetId).toMatch(/^ff-\d+$/);
    // IDs should be distinct
    expect(pages[0].targetId).not.toBe(pages[1].targetId);
  });

  it("createPageViaPlaywright throws when Firefox context is missing", async () => {
    vi.mocked(getFirefoxContext).mockReturnValue(undefined);
    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18801",
        url: "https://example.com",
        engine: "firefox",
        profileName: "ff-missing",
      }),
    ).rejects.toThrow(/not available/);
  });

  it("createPageViaPlaywright creates page with synthetic ID", async () => {
    const newPage = fakeFirefoxPage("about:blank", "New Tab");
    const mockContext = {
      newPage: vi.fn(async () => newPage),
    } as unknown as BrowserContext;

    vi.mocked(getFirefoxContext).mockReturnValue(mockContext);

    const result = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18801",
      url: "",
      engine: "firefox",
      profileName: "ff-create-test",
    });

    expect(result.targetId).toMatch(/^ff-\d+$/);
    expect(result.type).toBe("page");
    expect(mockContext.newPage).toHaveBeenCalled();
  });
});
