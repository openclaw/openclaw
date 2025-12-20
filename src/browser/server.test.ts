import { type AddressInfo, createServer } from "node:net";
import { fetch as realFetch } from "undici";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testPort = 0;
let reachable = false;
let cfgAttachOnly = false;
let createTargetId: string | null = null;
let screenshotThrowsOnce = false;

function makeProc(pid = 123) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
    killed: false,
    exitCode: null as number | null,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return undefined;
    },
    emitExit: () => {
      for (const cb of handlers.get("exit") ?? []) cb(0);
    },
    kill: () => {
      return true;
    },
  };
}

const proc = makeProc();

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    browser: {
      enabled: true,
      controlUrl: `http://127.0.0.1:${testPort}`,
      color: "#FF4500",
      attachOnly: cfgAttachOnly,
      headless: true,
    },
  }),
}));

const launchCalls = vi.hoisted(() => [] as Array<{ port: number }>);
vi.mock("./chrome.js", () => ({
  isChromeReachable: vi.fn(async () => reachable),
  launchClawdChrome: vi.fn(async (resolved: { cdpPort: number }) => {
    launchCalls.push({ port: resolved.cdpPort });
    reachable = true;
    return {
      pid: 123,
      exe: { kind: "chrome", path: "/fake/chrome" },
      userDataDir: "/tmp/clawd",
      cdpPort: resolved.cdpPort,
      startedAt: Date.now(),
      proc,
    };
  }),
  stopClawdChrome: vi.fn(async () => {
    reachable = false;
  }),
}));

const evalCalls = vi.hoisted(() => [] as Array<string>);
let evalThrows = false;
vi.mock("./cdp.js", () => ({
  createTargetViaCdp: vi.fn(async () => {
    if (createTargetId) return { targetId: createTargetId };
    throw new Error("cdp disabled");
  }),
  evaluateJavaScript: vi.fn(async ({ expression }: { expression: string }) => {
    evalCalls.push(expression);
    if (evalThrows) {
      return {
        exceptionDetails: { text: "boom" },
      };
    }
    return { result: { type: "string", value: "ok" } };
  }),
  getDomText: vi.fn(async () => ({ text: "<html/>" })),
  querySelector: vi.fn(async () => ({ matches: [{ index: 0, tag: "a" }] })),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
  })),
  snapshotDom: vi.fn(async () => ({
    nodes: [{ ref: "1", parentRef: null, depth: 0, tag: "html" }],
  })),
  captureScreenshot: vi.fn(async () => {
    if (screenshotThrowsOnce) {
      screenshotThrowsOnce = false;
      throw new Error("jpeg failed");
    }
    return Buffer.from("jpg");
  }),
  captureScreenshotPng: vi.fn(async () => Buffer.from("png")),
}));

vi.mock("./pw-ai.js", () => ({
  clickRefViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  closePageViaPlaywright: vi.fn(async () => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
  fileUploadViaPlaywright: vi.fn(async () => {}),
  fillFormViaPlaywright: vi.fn(async () => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  handleDialogViaPlaywright: vi.fn(async () => ({
    message: "ok",
    type: "alert",
  })),
  hoverViaPlaywright: vi.fn(async () => {}),
  mouseClickViaPlaywright: vi.fn(async () => {}),
  mouseDragViaPlaywright: vi.fn(async () => {}),
  mouseMoveViaPlaywright: vi.fn(async () => {}),
  navigateBackViaPlaywright: vi.fn(async () => ({ url: "about:blank" })),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async () => {}),
  resizeViewportViaPlaywright: vi.fn(async () => {}),
  runCodeViaPlaywright: vi.fn(async () => "ok"),
  selectOptionViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  typeViaPlaywright: vi.fn(async () => {}),
  verifyElementVisibleViaPlaywright: vi.fn(async () => {}),
  verifyListVisibleViaPlaywright: vi.fn(async () => {}),
  verifyTextVisibleViaPlaywright: vi.fn(async () => {}),
  verifyValueViaPlaywright: vi.fn(async () => {}),
  waitForViaPlaywright: vi.fn(async () => {}),
  dragViaPlaywright: vi.fn(async () => {}),
}));

vi.mock("../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buf: Buffer) => ({
    buffer: buf,
    contentType: "image/png",
  })),
}));

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; text?: string },
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const text = init?.text ?? "";
  return {
    ok,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

describe("browser control server", () => {
  beforeEach(async () => {
    reachable = false;
    cfgAttachOnly = false;
    createTargetId = null;
    screenshotThrowsOnce = false;
    testPort = await getFreePort();

    // Minimal CDP JSON endpoints used by the server.
    let putNewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/json/list")) {
          if (!reachable) return makeResponse([]);
          return makeResponse([
            {
              id: "abcd1234",
              title: "Tab",
              url: "https://example.com",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abcd1234",
              type: "page",
            },
            {
              id: "abce9999",
              title: "Other",
              url: "https://other",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abce9999",
              type: "page",
            },
          ]);
        }
        if (u.includes("/json/new?")) {
          if (init?.method === "PUT") {
            putNewCalls += 1;
            if (putNewCalls === 1) {
              return makeResponse({}, { ok: false, status: 405, text: "" });
            }
          }
          return makeResponse({
            id: "newtab1",
            title: "",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/newtab1",
            type: "page",
          });
        }
        if (u.includes("/json/activate/")) return makeResponse("ok");
        if (u.includes("/json/close/")) return makeResponse("ok");
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const { stopBrowserControlServer } = await import("./server.js");
    await stopBrowserControlServer();
  });

  it("serves status + starts browser when requested", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    const started = await startBrowserControlServerFromConfig();
    expect(started?.port).toBe(testPort);

    const base = `http://127.0.0.1:${testPort}`;
    const s1 = (await realFetch(`${base}/`).then((r) => r.json())) as {
      running: boolean;
      pid: number | null;
    };
    expect(s1.running).toBe(false);
    expect(s1.pid).toBe(null);

    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());
    const s2 = (await realFetch(`${base}/`).then((r) => r.json())) as {
      running: boolean;
      pid: number | null;
      chosenBrowser: string | null;
    };
    expect(s2.running).toBe(true);
    expect(s2.pid).toBe(123);
    expect(s2.chosenBrowser).toBe("chrome");
    expect(launchCalls.length).toBeGreaterThan(0);
  });

  it("handles tabs: list, open, focus conflict on ambiguous prefix", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());
    const tabs = (await realFetch(`${base}/tabs`).then((r) => r.json())) as {
      running: boolean;
      tabs: Array<{ targetId: string }>;
    };
    expect(tabs.running).toBe(true);
    expect(tabs.tabs.length).toBeGreaterThan(0);

    const opened = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }).then((r) => r.json());
    expect(opened).toMatchObject({ targetId: "newtab1" });

    const focus = await realFetch(`${base}/tabs/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "abc" }),
    });
    expect(focus.status).toBe(409);
  });

  it("maps JS exceptions to a 400 and returns results otherwise", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    evalThrows = true;
    const bad = await realFetch(`${base}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ js: "throw 1" }),
    });
    expect(bad.status).toBe(400);

    evalThrows = false;
    const ok = (await realFetch(`${base}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ js: "1+1", await: true }),
    }).then((r) => r.json())) as { ok: boolean; result?: unknown };
    expect(ok.ok).toBe(true);
    expect(evalCalls.length).toBeGreaterThan(0);
  });

  it("supports query/dom/snapshot/click/screenshot and stop", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    const query = (await realFetch(`${base}/query?selector=a&limit=1`).then(
      (r) => r.json(),
    )) as { ok: boolean; matches?: unknown[] };
    expect(query.ok).toBe(true);
    expect(Array.isArray(query.matches)).toBe(true);

    const dom = (await realFetch(`${base}/dom?format=text&maxChars=10`).then(
      (r) => r.json(),
    )) as { ok: boolean; text?: string };
    expect(dom.ok).toBe(true);
    expect(typeof dom.text).toBe("string");

    const snapAria = (await realFetch(
      `${base}/snapshot?format=aria&limit=1`,
    ).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
      nodes?: unknown[];
    };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string; snapshot?: string };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");

    const click = (await realFetch(`${base}/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "1" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(click.ok).toBe(true);

    const shot = (await realFetch(`${base}/screenshot?fullPage=true`).then(
      (r) => r.json(),
    )) as { ok: boolean; path?: string };
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });

  it("covers common error branches", async () => {
    cfgAttachOnly = true;
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const missing = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    reachable = false;
    const started = (await realFetch(`${base}/start`, {
      method: "POST",
    }).then((r) => r.json())) as { error?: string };
    expect(started.error ?? "").toMatch(/attachOnly/i);
  });

  it("opens tabs via CDP createTarget path and falls back to PNG screenshots", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    createTargetId = "abcd1234";
    const opened = (await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }).then((r) => r.json())) as { targetId?: string };
    expect(opened.targetId).toBe("abcd1234");

    screenshotThrowsOnce = true;
    const shot = (await realFetch(`${base}/screenshot`).then((r) =>
      r.json(),
    )) as { ok: boolean; path?: string };
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
  });

  it("covers additional endpoint branches", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const tabsWhenStopped = (await realFetch(`${base}/tabs`).then((r) =>
      r.json(),
    )) as { running: boolean; tabs: unknown[] };
    expect(tabsWhenStopped.running).toBe(false);
    expect(Array.isArray(tabsWhenStopped.tabs)).toBe(true);

    const focusStopped = await realFetch(`${base}/tabs/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "abcd" }),
    });
    expect(focusStopped.status).toBe(409);

    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    const focusMissing = await realFetch(`${base}/tabs/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "zzz" }),
    });
    expect(focusMissing.status).toBe(404);

    const delAmbiguous = await realFetch(`${base}/tabs/abc`, {
      method: "DELETE",
    });
    expect(delAmbiguous.status).toBe(409);

    const shotAmbiguous = await realFetch(`${base}/screenshot?targetId=abc`);
    expect(shotAmbiguous.status).toBe(409);

    const evalMissing = await realFetch(`${base}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(evalMissing.status).toBe(400);

    const queryMissing = await realFetch(`${base}/query`);
    expect(queryMissing.status).toBe(400);

    const snapDom = (await realFetch(
      `${base}/snapshot?format=domSnapshot&limit=1`,
    ).then((r) => r.json())) as { ok: boolean; format?: string };
    expect(snapDom.ok).toBe(true);
    expect(snapDom.format).toBe("domSnapshot");
  });
});
