import { type AddressInfo, createServer } from "node:net";
import { fetch as realFetch } from "undici";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testPort = 0;
let cdpBaseUrl = "";
let reachable = false;
let cfgAttachOnly = false;
let createTargetId: string | null = null;

const cdpMocks = vi.hoisted(() => ({
  createTargetViaCdp: vi.fn(async () => {
    throw new Error("cdp disabled");
  }),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
  })),
}));

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  closePageViaPlaywright: vi.fn(async () => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  dragViaPlaywright: vi.fn(async () => {}),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
  fillFormViaPlaywright: vi.fn(async () => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  hoverViaPlaywright: vi.fn(async () => {}),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async () => {}),
  resizeViewportViaPlaywright: vi.fn(async () => {}),
  selectOptionViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  typeViaPlaywright: vi.fn(async () => {}),
  waitForViaPlaywright: vi.fn(async () => {}),
}));

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

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
        controlUrl: `http://127.0.0.1:${testPort}`,
        color: "#FF4500",
        attachOnly: cfgAttachOnly,
        headless: true,
        defaultProfile: "clawd",
        profiles: {
          clawd: { cdpPort: testPort + 1, color: "#FF4500" },
        },
      },
    }),
    writeConfigFile: vi.fn(async () => {}),
  };
});

const launchCalls = vi.hoisted(() => [] as Array<{ port: number }>);
vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => reachable),
  isChromeReachable: vi.fn(async () => reachable),
  launchClawdChrome: vi.fn(
    async (_resolved: unknown, profile: { cdpPort: number }) => {
      launchCalls.push({ port: profile.cdpPort });
      reachable = true;
      return {
        pid: 123,
        exe: { kind: "chrome", path: "/fake/chrome" },
        userDataDir: "/tmp/clawd",
        cdpPort: profile.cdpPort,
        startedAt: Date.now(),
        proc,
      };
    },
  ),
  resolveClawdUserDataDir: vi.fn(() => "/tmp/clawd"),
  stopClawdChrome: vi.fn(async () => {
    reachable = false;
  }),
}));

vi.mock("./cdp.js", () => ({
  createTargetViaCdp: cdpMocks.createTargetViaCdp,
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: cdpMocks.snapshotAria,
}));

vi.mock("./pw-ai.js", () => pwMocks);

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
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) return port;
  }
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

    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (createTargetId) return { targetId: createTargetId };
      throw new Error("cdp disabled");
    });

    for (const fn of Object.values(pwMocks)) fn.mockClear();
    for (const fn of Object.values(cdpMocks)) fn.mockClear();

    testPort = await getFreePort();
    cdpBaseUrl = `http://127.0.0.1:${testPort + 1}`;

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

  it("supports the agent contract and stop", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    const snapAria = (await realFetch(
      `${base}/snapshot?format=aria&limit=1`,
    ).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
      nodes?: unknown[];
    };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 1,
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string; snapshot?: string };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
    });

    const nav = (await realFetch(`${base}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }).then((r) => r.json())) as { ok: boolean; targetId?: string };
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    expect(pwMocks.navigateViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      url: "https://example.com",
    });

    const click = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "click",
        ref: "1",
        button: "left",
        modifiers: ["Shift"],
      }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      doubleClick: false,
      button: "left",
      modifiers: ["Shift"],
    });

    const clickSelector = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "click",
        selector: "button.save",
      }),
    });
    expect(clickSelector.status).toBe(400);
    const clickSelectorBody = (await clickSelector.json()) as {
      error?: string;
    };
    expect(clickSelectorBody.error).toMatch(/'selector' is not supported/i);

    const type = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "type", ref: "1", text: "" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      text: "",
      submit: false,
      slowly: false,
    });

    const press = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "press", key: "Enter" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(press.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      key: "Enter",
    });

    const hover = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "hover", ref: "2" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(hover.ok).toBe(true);
    expect(pwMocks.hoverViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const drag = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "drag", startRef: "3", endRef: "4" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(drag.ok).toBe(true);
    expect(pwMocks.dragViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      startRef: "3",
      endRef: "4",
    });

    const select = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "select", ref: "5", values: ["a", "b"] }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(select.ok).toBe(true);
    expect(pwMocks.selectOptionViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "5",
      values: ["a", "b"],
    });

    const fill = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "fill",
        fields: [{ ref: "6", type: "textbox", value: "hello" }],
      }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(fill.ok).toBe(true);
    expect(pwMocks.fillFormViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      fields: [{ ref: "6", type: "textbox", value: "hello" }],
    });

    const resize = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resize", width: 800, height: 600 }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(resize.ok).toBe(true);
    expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      width: 800,
      height: 600,
    });

    const wait = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "wait", timeMs: 5 }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(wait.ok).toBe(true);
    expect(pwMocks.waitForViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      timeMs: 5,
      text: undefined,
      textGone: undefined,
    });

    const evalRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", fn: "() => 1" }),
    }).then((r) => r.json())) as { ok: boolean; result?: unknown };
    expect(evalRes.ok).toBe(true);
    expect(evalRes.result).toBe("ok");
    expect(pwMocks.evaluateViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      fn: "() => 1",
      ref: undefined,
    });

    const upload = await realFetch(`${base}/hooks/file-chooser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["/tmp/a.txt"], timeoutMs: 1234 }),
    }).then((r) => r.json());
    expect(upload).toMatchObject({ ok: true });
    expect(pwMocks.armFileUploadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      paths: ["/tmp/a.txt"],
      timeoutMs: 1234,
    });

    const uploadWithRef = await realFetch(`${base}/hooks/file-chooser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["/tmp/b.txt"], ref: "e12" }),
    }).then((r) => r.json());
    expect(uploadWithRef).toMatchObject({ ok: true });
    expect(pwMocks.armFileUploadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      paths: ["/tmp/b.txt"],
      timeoutMs: undefined,
    });
    expect(pwMocks.clickViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: "e12",
    });

    const uploadWithInputRef = await realFetch(`${base}/hooks/file-chooser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["/tmp/c.txt"], inputRef: "e99" }),
    }).then((r) => r.json());
    expect(uploadWithInputRef).toMatchObject({ ok: true });
    expect(pwMocks.setInputFilesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      inputRef: "e99",
      element: undefined,
      paths: ["/tmp/c.txt"],
    });

    const uploadWithElement = await realFetch(`${base}/hooks/file-chooser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["/tmp/d.txt"],
        element: "input[type=file]",
      }),
    }).then((r) => r.json());
    expect(uploadWithElement).toMatchObject({ ok: true });
    expect(pwMocks.setInputFilesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      inputRef: undefined,
      element: "input[type=file]",
      paths: ["/tmp/d.txt"],
    });

    const dialog = await realFetch(`${base}/hooks/dialog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept: true, timeoutMs: 5678 }),
    }).then((r) => r.json());
    expect(dialog).toMatchObject({ ok: true });
    expect(pwMocks.armDialogViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      accept: true,
      promptText: undefined,
      timeoutMs: 5678,
    });

    const consoleRes = (await realFetch(`${base}/console?level=error`).then(
      (r) => r.json(),
    )) as { ok: boolean; messages?: unknown[] };
    expect(consoleRes.ok).toBe(true);
    expect(Array.isArray(consoleRes.messages)).toBe(true);
    expect(pwMocks.getConsoleMessagesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      level: "error",
    });

    const pdf = (await realFetch(`${base}/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json())) as { ok: boolean; path?: string };
    expect(pdf.ok).toBe(true);
    expect(typeof pdf.path).toBe("string");

    const shot = (await realFetch(`${base}/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ element: "body", type: "jpeg" }),
    }).then((r) => r.json())) as { ok: boolean; path?: string };
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
    expect(pwMocks.takeScreenshotViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
      ref: undefined,
      element: "body",
      fullPage: false,
      type: "jpeg",
    });

    const close = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "close" }),
    }).then((r) => r.json())) as { ok: boolean };
    expect(close.ok).toBe(true);
    expect(pwMocks.closePageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: cdpBaseUrl,
      targetId: "abcd1234",
    });

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });

  it("validates agent inputs (agent routes)", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;
    await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());

    const navMissing = await realFetch(`${base}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(navMissing.status).toBe(400);

    const actMissing = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(actMissing.status).toBe(400);

    const clickMissingRef = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click" }),
    });
    expect(clickMissingRef.status).toBe(400);

    const clickBadButton = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", ref: "1", button: "nope" }),
    });
    expect(clickBadButton.status).toBe(400);

    const clickBadModifiers = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", ref: "1", modifiers: ["Nope"] }),
    });
    expect(clickBadModifiers.status).toBe(400);

    const typeBadText = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "type", ref: "1", text: 123 }),
    });
    expect(typeBadText.status).toBe(400);

    const uploadMissingPaths = await realFetch(`${base}/hooks/file-chooser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(uploadMissingPaths.status).toBe(400);

    const dialogMissingAccept = await realFetch(`${base}/hooks/dialog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(dialogMissingAccept.status).toBe(400);

    const snapDefault = (await realFetch(`${base}/snapshot?format=wat`).then(
      (r) => r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapDefault.ok).toBe(true);
    expect(snapDefault.format).toBe("ai");

    const screenshotBadCombo = await realFetch(`${base}/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullPage: true, element: "body" }),
    });
    expect(screenshotBadCombo.status).toBe(400);
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

  it("opens tabs via CDP createTarget path", async () => {
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

    const snapAmbiguous = await realFetch(
      `${base}/snapshot?format=aria&targetId=abc`,
    );
    expect(snapAmbiguous.status).toBe(409);
  });
});

describe("backward compatibility (profile parameter)", () => {
  beforeEach(async () => {
    reachable = false;
    cfgAttachOnly = false;
    createTargetId = null;

    for (const fn of Object.values(pwMocks)) fn.mockClear();
    for (const fn of Object.values(cdpMocks)) fn.mockClear();

    testPort = await getFreePort();
    cdpBaseUrl = `http://127.0.0.1:${testPort + 1}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
          ]);
        }
        if (u.includes("/json/new?")) {
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

  it("GET / without profile uses default profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const status = (await realFetch(`${base}/`).then((r) => r.json())) as {
      running: boolean;
      profile?: string;
    };
    expect(status.running).toBe(false);
    // Should use default profile (clawd)
    expect(status.profile).toBe("clawd");
  });

  it("POST /start without profile uses default profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = (await realFetch(`${base}/start`, { method: "POST" }).then(
      (r) => r.json(),
    )) as { ok: boolean; profile?: string };
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("clawd");
  });

  it("POST /stop without profile uses default profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" });

    const result = (await realFetch(`${base}/stop`, { method: "POST" }).then(
      (r) => r.json(),
    )) as { ok: boolean; profile?: string };
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("clawd");
  });

  it("GET /tabs without profile uses default profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" });

    const result = (await realFetch(`${base}/tabs`).then((r) => r.json())) as {
      running: boolean;
      tabs: unknown[];
    };
    expect(result.running).toBe(true);
    expect(Array.isArray(result.tabs)).toBe(true);
  });

  it("POST /tabs/open without profile uses default profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" });

    const result = (await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }).then((r) => r.json())) as { targetId?: string };
    expect(result.targetId).toBe("newtab1");
  });

  it("GET /profiles returns list of profiles", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = (await realFetch(`${base}/profiles`).then((r) =>
      r.json(),
    )) as { profiles: Array<{ name: string }> };
    expect(Array.isArray(result.profiles)).toBe(true);
    // Should at least have the default clawd profile
    expect(result.profiles.some((p) => p.name === "clawd")).toBe(true);
  });

  it("GET /tabs?profile=clawd returns tabs for specified profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" });

    const result = (await realFetch(`${base}/tabs?profile=clawd`).then((r) =>
      r.json(),
    )) as { running: boolean; tabs: unknown[] };
    expect(result.running).toBe(true);
    expect(Array.isArray(result.tabs)).toBe(true);
  });

  it("POST /tabs/open?profile=clawd opens tab in specified profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    await realFetch(`${base}/start`, { method: "POST" });

    const result = (await realFetch(`${base}/tabs/open?profile=clawd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }).then((r) => r.json())) as { targetId?: string };
    expect(result.targetId).toBe("newtab1");
  });

  it("GET /tabs?profile=unknown returns 404", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/tabs?profile=unknown`);
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("POST /tabs/open?profile=unknown returns 404", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/tabs/open?profile=unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });
});

describe("profile CRUD endpoints", () => {
  beforeEach(async () => {
    reachable = false;
    cfgAttachOnly = false;

    for (const fn of Object.values(pwMocks)) fn.mockClear();
    for (const fn of Object.values(cdpMocks)) fn.mockClear();

    testPort = await getFreePort();
    cdpBaseUrl = `http://127.0.0.1:${testPort + 1}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/json/list")) return makeResponse([]);
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

  it("POST /profiles/create returns 400 for missing name", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("name is required");
  });

  it("POST /profiles/create returns 400 for invalid name format", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid Name!" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("invalid profile name");
  });

  it("POST /profiles/create returns 409 for duplicate name", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    // "clawd" already exists as the default profile
    const result = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "clawd" }),
    });
    expect(result.status).toBe(409);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });

  it("POST /profiles/create accepts cdpUrl for remote profiles", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "remote", cdpUrl: "http://10.0.0.42:9222" }),
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as {
      profile?: string;
      cdpUrl?: string;
      isRemote?: boolean;
    };
    expect(body.profile).toBe("remote");
    expect(body.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(body.isRemote).toBe(true);
  });

  it("POST /profiles/create returns 400 for invalid cdpUrl", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "badremote", cdpUrl: "ws://bad" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("cdpUrl");
  });

  it("DELETE /profiles/:name returns 404 for non-existent profile", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/nonexistent`, {
      method: "DELETE",
    });
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("DELETE /profiles/:name returns 400 for default profile deletion", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    // clawd is the default profile
    const result = await realFetch(`${base}/profiles/clawd`, {
      method: "DELETE",
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("cannot delete the default profile");
  });

  it("DELETE /profiles/:name returns 400 for invalid name format", async () => {
    const { startBrowserControlServerFromConfig } = await import("./server.js");
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const result = await realFetch(`${base}/profiles/Invalid-Name!`, {
      method: "DELETE",
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("invalid profile name");
  });
});
