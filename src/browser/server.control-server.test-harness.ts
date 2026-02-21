import { afterEach, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";
import { getFreePort } from "./test-port.js";

export { getFreePort } from "./test-port.js";

type HarnessState = {
  testPort: number;
  cdpBaseUrl: string;
  reachable: boolean;
  cfgAttachOnly: boolean;
  cfgEvaluateEnabled: boolean;
  cfgDefaultProfile: string;
  cfgProfiles: Record<
    string,
    {
      cdpPort?: number;
      cdpUrl?: string;
      color: string;
      driver?: "openclaw" | "extension" | "existing-session";
      attachOnly?: boolean;
    }
  >;
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
  cfgDefaultProfile: "openclaw",
  cfgProfiles: {},
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

export function setBrowserControlServerProfiles(
  profiles: HarnessState["cfgProfiles"],
  defaultProfile = Object.keys(profiles)[0] ?? "openclaw",
): void {
  state.cfgProfiles = profiles;
  state.cfgDefaultProfile = defaultProfile;
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
  batchViaPlaywright: vi.fn(async () => ({ results: [] })),
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

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpElement: vi.fn(async () => {}),
  closeChromeMcpSession: vi.fn(async () => true),
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async () => true),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
  hoverChromeMcpElement: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  openChromeMcpTab: vi.fn(async (_profile: string, url: string) => ({
    targetId: "8",
    title: "",
    url,
    type: "page",
  })),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

export function getChromeMcpMocks(): Record<string, MockFn> {
  return chromeMcpMocks as unknown as Record<string, MockFn>;
}

const chromeUserDataDir = vi.hoisted(() => ({ dir: "/tmp/openclaw" }));
installChromeUserDataDirHooks(chromeUserDataDir);

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

function defaultProfilesForState(testPort: number): HarnessState["cfgProfiles"] {
  return {
    openclaw: { cdpPort: testPort + 9, color: "#FF4500" },
  };
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const loadConfig = () => {
    return {
      browser: {
        enabled: true,
        evaluateEnabled: state.cfgEvaluateEnabled,
        color: "#FF4500",
        attachOnly: state.cfgAttachOnly,
        headless: true,
        defaultProfile: state.cfgDefaultProfile,
        profiles:
          Object.keys(state.cfgProfiles).length > 0
            ? state.cfgProfiles
            : defaultProfilesForState(state.testPort),
      },
    };
  };
  const writeConfigFile = vi.fn(async () => {});
  return {
    ...actual,
    createConfigIO: vi.fn(() => ({
      loadConfig,
      writeConfigFile,
    })),
    getRuntimeConfigSnapshot: vi.fn(() => null),
    loadConfig,
    writeConfigFile,
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
  resolveBrowserExecutable: vi.fn(() => ({ kind: "chrome", path: "/fake/chrome" })),
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

vi.mock("./chrome-mcp.js", () => chromeMcpMocks);

vi.mock("../media/store.js", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  ensureMediaDir: vi.fn(async () => {}),
  getMediaDir: vi.fn(() => "/tmp"),
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

export async function resetBrowserControlServerTestContext(): Promise<void> {
  state.reachable = false;
  state.cfgAttachOnly = false;
  state.cfgEvaluateEnabled = true;
  state.cfgDefaultProfile = "openclaw";
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.createTargetId = null;

  mockClearAll(pwMocks);
  mockClearAll(cdpMocks);
  mockClearAll(chromeMcpMocks);

  state.testPort = await getFreePort();
  state.cdpBaseUrl = `http://127.0.0.1:${state.testPort + 9}`;
  state.cfgProfiles = defaultProfilesForState(state.testPort);
  state.prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = String(state.testPort - 2);
  // Avoid flaky auth coupling: some suites temporarily set gateway env auth
  // which would make the browser control server require auth.
  state.prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  state.prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
}

export function restoreGatewayAuthEnv(
  prevGatewayToken: string | undefined,
  prevGatewayPassword: string | undefined,
): void {
  if (prevGatewayToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
  }
  if (prevGatewayPassword === undefined) {
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  } else {
    process.env.OPENCLAW_GATEWAY_PASSWORD = prevGatewayPassword;
  }
}

export async function cleanupBrowserControlServerTestContext(): Promise<void> {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreGatewayPortEnv(state.prevGatewayPort);
  restoreGatewayAuthEnv(state.prevGatewayToken, state.prevGatewayPassword);
  await stopBrowserControlServer();
}

export function installBrowserControlServerHooks() {
  beforeEach(async () => {
    cdpMocks.createTargetViaCdp.mockImplementation(async () => {
      if (state.createTargetId) {
        return { targetId: state.createTargetId };
      }
      throw new Error("cdp disabled");
    });

    await resetBrowserControlServerTestContext();

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
    await cleanupBrowserControlServerTestContext();
  });
}
