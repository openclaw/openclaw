import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  scrollBrowserBy,
  fetchBrowserScreenshotDataUrl,
  requestBrowserDashboard,
  isBrowserScreencastUnsupportedError,
  bindBrowserRequestClient,
  downloadBrowserDocument,
} from "./browser-client.ts";
import {
  createBrowserClient,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { createBrowserPanelOperations } from "./browser-panel-operation-ownership.ts";

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("session browser requests", () => {
  const dashboard = {
    sessionKey: "agent:main:review",
    agentId: "main",
    name: "preview",
    instanceId: "preview-1",
    sessionScoped: true,
  };

  it.each(["session", "dashboard", "session-dashboard"] as const)(
    "scopes only the session panel and sends transcript references only with its list (%s)",
    async (surface) => {
      const { client: gateway, request } = createBrowserClient(async () => ({}), {
        sessionScoped: surface === "session-dashboard",
      });
      const host = new TestBrowserPanelHost(gateway);
      host.sessionKey = "  agent:main:panel  ";
      host.sessionTabs = Array.from({ length: 65 }, (_, index) => ({
        target: "host",
        profile: "openclaw",
        targetId: `t${index}`,
      }));
      if (surface === "dashboard" || surface === "session-dashboard") {
        host.dashboardTarget = { ...dashboard, sessionScoped: surface === "session-dashboard" };
      }
      const ownership = createBrowserPanelOperations(host);
      const client = ownership.captureClient();
      if (!client) {
        throw new Error("Expected a live panel client");
      }
      for (const envelope of [
        { method: "GET", path: "/tabs" },
        { method: "POST", path: "/tabs/open", body: { url: "https://example.test" } },
        {
          method: "POST",
          path: "/navigate",
          body: { targetId: "t1", url: "https://example.test" },
        },
        { method: "POST", path: "/tabs/focus", body: { targetId: "t1" } },
        { method: "DELETE", path: "/tabs/t1" },
      ]) {
        await client.request("browser.request", envelope);
        const params = request.mock.calls.at(-1)?.[1];
        if (surface === "session") {
          expect(params).toEqual({
            ...envelope,
            tabScope: {
              sessionKey: "agent:main:panel",
              ...(envelope.path === "/tabs" ? { referencedTabs: host.sessionTabs.slice(1) } : {}),
            },
          });
        } else {
          expect(params).not.toHaveProperty("tabScope");
        }
      }
    },
  );

  it("binds tab actions to the session owner without forwarding global browser selectors", async () => {
    const request = vi.fn().mockResolvedValue({});
    let current = true;
    const client = bindBrowserRequestClient(
      { request },
      { target: "node", node: "global-node", profile: "personal" },
      () => current,
      dashboard,
    );
    await client.request("browser.request", {
      method: "POST",
      path: "/navigate",
      target: "host",
      query: { targetId: "foreign-tab", profile: "personal", node: "foreign-node" },
      body: {
        targetId: "foreign-tab",
        profile: "personal",
        target: "node",
        url: "https://example.test",
      },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("browser.dashboard.request", {
      method: "POST",
      path: "/navigate",
      query: {},
      body: { url: "https://example.test" },
      sessionKey: dashboard.sessionKey,
      agentId: "main",
      dashboard: { name: "preview", instanceId: "preview-1" },
    });
    current = false;
    await expect(
      client.request("browser.request", { method: "POST", path: "/act" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["resume", "POST"],
    ["stop", "DELETE"],
    ["inspect", "GET"],
  ] as const)("sends %s through scoped dashboard admission", async (action, method) => {
    const request = vi.fn().mockResolvedValue({
      sessionKey: dashboard.sessionKey,
      name: dashboard.name,
      instanceId: dashboard.instanceId,
      revision: 1,
      paused: true,
      stopping: false,
      url: "https://example.test",
    });
    await requestBrowserDashboard({ request }, dashboard, action);
    expect(request).toHaveBeenCalledWith(
      "browser.dashboard.request",
      {
        sessionKey: dashboard.sessionKey,
        agentId: "main",
        dashboard: { name: "preview", instanceId: "preview-1" },
        method,
        path: "/dashboard",
        ...(action === "inspect"
          ? { query: {} }
          : { body: action === "resume" ? { resume: true } : {} }),
        timeoutMs: 120_000,
      },
      { timeoutMs: 150_000 },
    );
  });
});

describe("downloadBrowserDocument", () => {
  it("retains route authority, cancellation and the transfer deadline", async () => {
    const request = vi.fn().mockResolvedValue({
      download: { path: "/managed/report.pdf", suggestedFilename: "Report.pdf" },
    });
    const signal = new AbortController().signal;
    const client = bindBrowserRequestClient(
      { request },
      { target: "node", node: "browser-node", profile: "work" },
    );
    await expect(
      downloadBrowserDocument(client, "tab-a", "https://assets.example.test/report", signal),
    ).resolves.toEqual({ path: "/managed/report.pdf", filename: "Report.pdf" });
    expect(request).toHaveBeenCalledWith(
      "browser.request",
      {
        method: "POST",
        path: "/download",
        target: "node",
        node: "browser-node",
        query: { profile: "work" },
        body: {
          targetId: "tab-a",
          currentDocument: true,
          expectedUrl: "https://assets.example.test/report",
          timeoutMs: 120_000,
        },
        timeoutMs: 150_000,
      },
      { signal, timeoutMs: 150_000 },
    );
  });

  it.each([{ download: { path: "/managed/report.pdf" } }])(
    "rejects incomplete managed file replies %#",
    async (reply) => {
      const request = vi.fn().mockResolvedValue(reply);
      await expect(
        downloadBrowserDocument(
          { request },
          "tab-a",
          "https://assets.example.test/report",
          new AbortController().signal,
        ),
      ).rejects.toThrow("No file returned.");
    },
  );
});

describe("fetchBrowserScreenshotDataUrl", () => {
  it("rejects an unsuccessful screenshot without waiting for stream cancellation", async () => {
    vi.useFakeTimers();
    const response = new Response("not found", { status: 404 });
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockImplementation(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Screenshot fetch failed (404).");
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled screenshot fetch after the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            // Fetch rejects with the exact abort reason. DOM types define it as an Error,
            // although jsdom does not preserve that prototype relationship at runtime.
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      resourceBasePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/openclaw/__openclaw__/assistant-media?source=%2Ftmp%2Fbrowser+shot.png");
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("aborts a stalled screenshot body after the request deadline", async () => {
    vi.useFakeTimers();
    let bodyReadStarted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing screenshot fetch signal");
      }
      return {
        ok: true,
        blob: async () => {
          bodyReadStarted = true;
          return await new Promise<Blob>((_resolve, reject) => {
            const rejectWithAbortReason = () => reject(signal.reason as Error);
            if (signal.aborted) {
              rejectWithAbortReason();
              return;
            }
            signal.addEventListener("abort", rejectWithAbortReason, { once: true });
          });
        },
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBrowserScreenshotDataUrl({
      resourceBasePath: "/openclaw",
      authToken: null,
      path: "/tmp/browser shot.png",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyReadStarted).toBe(true);
    expect(init?.signal?.aborted).toBe(false);

    const outcome = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("localizes screenshot failures while preserving the HTTP status", async () => {
    i18n.registerTranslation("pt-BR", {
      browser: {
        errors: {
          screenshotFetchFailed: "Falha ao buscar captura de tela ({status}).",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    );

    await expect(
      fetchBrowserScreenshotDataUrl({
        resourceBasePath: "/openclaw",
        authToken: null,
        path: "/tmp/missing.png",
      }),
    ).rejects.toThrow("Falha ao buscar captura de tela (503).");
  });
});

describe("browser screencast requests", () => {
  it.each([
    [{ body: { code: "SCREENCAST_UNSUPPORTED" } }, true],
    [{ details: { body: { code: "SCREENCAST_UNSUPPORTED" } } }, true],
  ])("recognizes structured unsupported failures (%s)", (error, expected) => {
    expect(isBrowserScreencastUnsupportedError(error)).toBe(expected);
  });
});

describe("browser wheel script", () => {
  // jsdom has no layout, so give each scroller the sizes a browser would report.
  function scroller(id: string, overflow: string, size: { client: number; scroll: number }) {
    const el = document.createElement(id === "body" ? "body" : "div");
    el.id = id;
    el.style.overflowY = overflow;
    el.style.overflowX = overflow;
    for (const axis of ["Height", "Width"] as const) {
      Object.defineProperty(el, `client${axis}`, { configurable: true, value: size.client });
      Object.defineProperty(el, `scroll${axis}`, { configurable: true, value: size.scroll });
    }
    const scrollBy = vi.fn();
    el.scrollBy = scrollBy;
    return { el, scrollBy };
  }

  async function runAt(
    target: Element | null,
    params: Omit<Parameters<typeof scrollBrowserBy>[1], "targetId">,
  ) {
    // jsdom has no hit testing; report the element a browser would find under the pointer.
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });
    const windowScroll = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const { client } = createBrowserClient(async (envelope) => {
      const fn = envelope.body?.fn;
      if (typeof fn !== "string") {
        throw new Error("Expected a browser evaluate script");
      }
      return {
        result: runInNewContext(`(${fn})()`, {
          document,
          window,
          getComputedStyle,
          ShadowRoot,
        }),
      };
    });
    await scrollBrowserBy(client, { targetId: "tab-a", ...params });
    return { windowScroll };
  }

  afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("scrolls the nested scroller under the pointer instead of the document", async () => {
    const { el: list, scrollBy } = scroller("list", "auto", { client: 300, scroll: 3000 });
    const item = document.createElement("span");
    list.append(item);
    document.body.append(list);

    const { windowScroll } = await runAt(item, {
      deltaX: 0,
      deltaY: 400,
      point: { x: 150, y: 300 },
    });

    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 400);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("chains to the document when the scroller under the pointer cannot move further", async () => {
    const { el: list, scrollBy } = scroller("list", "auto", { client: 300, scroll: 3000 });
    list.scrollTop = 2700;
    document.body.append(list);

    const { windowScroll } = await runAt(list, { deltaX: 0, deltaY: 400, point: { x: 10, y: 10 } });

    expect(scrollBy).not.toHaveBeenCalled();
    expect(windowScroll).toHaveBeenCalledExactlyOnceWith(0, 400);
  });

  it("skips overflow-hidden ancestors and scrolls the document without a point", async () => {
    const { el: clipped, scrollBy } = scroller("clipped", "hidden", { client: 300, scroll: 3000 });
    document.body.append(clipped);

    expect(
      (await runAt(clipped, { deltaX: 0, deltaY: 120, point: { x: 5, y: 5 } })).windowScroll,
    ).toHaveBeenCalledExactlyOnceWith(0, 120);
    expect(scrollBy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(
      (await runAt(clipped, { deltaX: 30, deltaY: 0 })).windowScroll,
    ).toHaveBeenCalledExactlyOnceWith(30, 0);
  });
  it.each([
    { left: 0, delta: -40, nested: true },
    { left: -100, delta: 40, nested: true },
    { left: -2700, delta: -40, nested: false },
    { left: 0, delta: 40, nested: false },
  ])("scrolls or chains RTL input at $left by $delta", async ({ left, delta, nested }) => {
    const { el, scrollBy } = scroller("rtl", "auto", { client: 300, scroll: 3000 });
    el.style.direction = "rtl";
    el.scrollLeft = left;
    const { el: outer, scrollBy: scrollOuter } = scroller("outer", "auto", {
      client: 300,
      scroll: 3000,
    });
    outer.style.direction = "rtl";
    outer.scrollLeft = -100;
    outer.append(el);
    document.body.append(outer);
    const { windowScroll } = await runAt(el, { deltaX: delta, deltaY: 0, point: { x: 10, y: 10 } });
    expect(scrollBy).toHaveBeenCalledTimes(nested ? 1 : 0);
    expect(scrollOuter).toHaveBeenCalledTimes(nested ? 0 : 1);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("scrolls an independently scrollable body", async () => {
    const { el, scrollBy } = scroller("body", "auto", { client: 300, scroll: 3000 });
    const previousBody = document.body;
    document.documentElement.replaceChild(el, previousBody);
    try {
      const { windowScroll } = await runAt(el, { deltaX: 0, deltaY: 80, point: { x: 10, y: 10 } });
      expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 80);
      expect(windowScroll).not.toHaveBeenCalled();
    } finally {
      document.documentElement.replaceChild(previousBody, el);
    }
  });
});
