import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { getFreePort } from "./test-port.js";

export { getFreePort } from "./test-port.js";

type HarnessState = {
  testPort: number;
  cdpBaseUrl: string;
  reachable: boolean;
  cfgAttachOnly: boolean;
  cfgEvaluateEnabled: boolean;
  createTargetId: string | null;
  prevGatewayPort: string | undefined;
  prevGatewayToken: string | undefined;
  prevGatewayPassword: string | undefined;
};

const state: HarnessState = {
  testPort: 0,
  cdpBaseUrl: "",
  reachable: false,
  cfgAttachOnly: false,
  cfgEvaluateEnabled: true,
  createTargetId: null,
  prevGatewayPort: undefined,
  prevGatewayToken: undefined,
  prevGatewayPassword: undefined,
};

export function getBrowserControlServerTestState(): HarnessState {
  return state;
}

export function getBrowserControlServerBaseUrl(): string {
  return `http://127.0.0.1:${state.testPort}`;
}

export function restoreGatewayPortEnv(prevGatewayPort: string | undefined): void {
  if (prevGatewayPort === undefined) {
    delete process.env.OPENCLAW_GATEWAY_PORT;
    return;
  }
  process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
}

export function setBrowserControlServerCreateTargetId(targetId: string | null): void {
  state.createTargetId = targetId;
}

export function setBrowserControlServerAttachOnly(attachOnly: boolean): void {
  state.cfgAttachOnly = attachOnly;
}

export function setBrowserControlServerEvaluateEnabled(enabled: boolean): void {
  state.cfgEvaluateEnabled = enabled;
}

export function setBrowserControlServerReachable(reachable: boolean): void {
  state.reachable = reachable;
}

const cdpMocks = vi.hoisted(() => ({
  createTargetViaCdp: vi.fn<() => Promise<{ targetId: string }>>(async () => {
    throw new Error("cdp disabled");
  }),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
  })),
}));

export function getCdpMocks(): { createTargetViaCdp: MockFn; snapshotAria: MockFn } {
  return cdpMocks as unknown as { createTargetViaCdp: MockFn; snapshotAria: MockFn };
}

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  closePageViaPlaywright: vi.fn(async () => {}),
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
  downloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  dragViaPlaywright: vi.fn(async () => {}),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
  fillFormViaPlaywright: vi.fn(async () => {}),
  getConsoleMessagesViaPlaywright: vi.fn(async () => []),
  hoverViaPlaywright: vi.fn(async () => {}),
  scrollIntoViewViaPlaywright: vi.fn(async () => {}),
  navigateViaPlaywright: vi.fn(async () => ({ url: "https://example.com" })),
  pdfViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("pdf") })),
  pressKeyViaPlaywright: vi.fn(async () => {}),
  responseBodyViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/api/data",
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  })),
  resizeViewportViaPlaywright: vi.fn(async () => {}),
  selectOptionViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok" })),
  traceStopViaPlaywright: vi.fn(async () => {}),
  takeScreenshotViaPlaywright: vi.fn(async () => ({
    buffer: Buffer.from("png"),
  })),
  typeViaPlaywright: vi.fn(async () => {}),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  waitForViaPlaywright: vi.fn(async () => {}),
}));

export function getPwMocks(): Record<string, MockFn> {
  return pwMocks as unknown as Record<string, MockFn>;
}

const chromeUserDataDir = vi.hoisted(() => ({ dir: "/tmp/openclaw" }));

beforeAll(async () => {
  chromeUserDataDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-user-data-"));
});

afterAll(async () => {
  await fs.rm(chromeUserDataDir.dir, { recursive: true, force: true });
});

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
      for (const cb of handlers.get("exit") ?? []) {
        cb(0);
      }
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
        evaluateEnabled: state.cfgEvaluateEnabled,
        color: "#FF4500",
        attachOnly: state.cfgAttachOnly,
        headless: true,
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: state.testPort + 1, color: "#FF4500" },
        },
      },
    }),
    writeConfigFile: vi.fn(async () => {}),
  };
});

const launchCalls = vi.hoisted(() => [] as Array<{ port: number }>);

export function getLaunchCalls() {
  return launchCalls;
}

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => state.reachable),
  isChromeReachable: vi.fn(async () => state.reachable),
  launchOpenClawChrome: vi.fn(async (_resolved: unknown, profile: { cdpPort: number }) => {
    launchCalls.push({ port: profile.cdpPort });
    state.reachable = true;
    return {
      pid: 123,
      exe: { kind: "chrome", path: "/fake/chrome" },
      userDataDir: chromeUserDataDir.dir,
      cdpPort: profile.cdpPort,
      startedAt: Date.now(),
      proc,
    };
  }),
  resolveOpenClawUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopOpenClawChrome: vi.fn(async () => {
    state.reachable = false;
  }),
}));

vi.mock("./cdp.js", () => ({
  createTargetViaCdp: cdpMocks.createTargetViaCdp,
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: cdpMocks.snapshotAria,
  getHeadersWithAuth: vi.fn(() => ({})),
  appendCdpPath: vi.fn((cdpUrl: string, cdpPath: string) => {
    const base = cdpUrl.replace(/\/$/, "");
    const suffix = cdpPath.startsWith("/") ? cdpPath : `/${cdpPath}`;
    return `${base}${suffix}`;
  }),
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

const server = await import("./server.js");
export const startBrowserControlServerFromConfig = server.startBrowserControlServerFromConfig;
export const stopBrowserControlServer = server.stopBrowserControlServer;

export function makeResponse(
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

function mockClearAll(obj: Record<string, { mockClear: () => unknown }>) {
  for (const fn of Object.values(obj)) {
    fn.mockClear();
  }
}

export function installBrowserControlServerHooks() {
  beforeEach(async () => {
    state.reachable = false;
    state.cfgAttachOnly = false;
    state.createTargetId = null;

    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (state.createTargetId) {
        return { targetId: state.createTargetId };
      }
      throw new Error("cdp disabled");
    });

    mockClearAll(pwMocks);
    mockClearAll(cdpMocks);

    state.testPort = await getFreePort();
    state.cdpBaseUrl = `http://127.0.0.1:${state.testPort + 1}`;
    state.prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = String(state.testPort - 2);
    // Avoid flaky auth coupling: some suites temporarily set gateway env auth
    // which would make the browser control server require auth.
    state.prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    state.prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    // Minimal CDP JSON endpoints used by the server.
    let putNewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/json/list")) {
          if (!state.reachable) {
            return makeResponse([]);
          }
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
        if (u.includes("/json/activate/")) {
          return makeResponse("ok");
        }
        if (u.includes("/json/close/")) {
          return makeResponse("ok");
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreGatewayPortEnv(state.prevGatewayPort);
    if (state.prevGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = state.prevGatewayToken;
    }
    if (state.prevGatewayPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = state.prevGatewayPassword;
    }
    await stopBrowserControlServer();
  });
}
