import type { GatewayClientRequestOptions } from "@openclaw/gateway-client";
import { afterEach, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { BrowserDashboardTarget, BrowserInspectedNode } from "./browser-client.ts";
import {
  createBrowserPanel,
  type BrowserPanel,
  type BrowserPanelHost,
} from "./browser-panel-owner.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";
import type { BrowserTabTarget } from "./browser-target.ts";

const BROWSER_PANEL_TEST_PAGE_TITLE = "Page";

export function stubBrowserPanelTestStageBounds(stage: Element): void {
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
}

export type BrowserRequestEnvelope = {
  method: string;
  path: string;
  target?: "host" | "node";
  node?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  tabScope?: { sessionKey: string; referencedTabs?: readonly BrowserTabTarget[] };
};

export function setupBrowserPanelTestCleanup(): void {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export function createBrowserClient(
  handleRequest: (envelope: BrowserRequestEnvelope) => Promise<unknown>,
  options: { screencast?: boolean; sessionScoped?: boolean } = {},
) {
  const request = vi.fn(
    async (method: string, params?: unknown, _options?: GatewayClientRequestOptions) => {
      if (method !== (options.sessionScoped ? "browser.dashboard.request" : "browser.request")) {
        throw new Error(`Unexpected Gateway method: ${method}`);
      }
      const envelope = params as BrowserRequestEnvelope;
      if (envelope.path === "/screencast" && !options.screencast) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Screencast unavailable",
          details: { code: "SCREENCAST_UNSUPPORTED", reason: "playwright" },
        });
      }
      return await handleRequest(envelope);
    },
  );
  return {
    client: {
      request,
      gatewayUrl: "https://gateway.example.test",
    } as unknown as GatewayBrowserClient,
    request,
  };
}

export function createBrowserPanelTestTab(id: string, url: string, title: string) {
  return {
    tabId: id,
    targetId: `raw-${id.replace(/-tab$/, "")}`,
    title,
    url,
  };
}

export function createBrowserPanelTestMetrics(url: string, title = BROWSER_PANEL_TEST_PAGE_TITLE) {
  return { result: { cssWidth: 100, cssHeight: 100, title, url } };
}

export class TestBrowserPanelHost implements BrowserPanelHost {
  readonly notify = vi.fn();
  readonly updateComplete = Promise.resolve(true);
  readonly renderRoot = document.createElement("div");
  readonly stage = document.createElement("div");
  readonly resourceBasePath = "";
  readonly authToken = null;
  sessionKey = "";
  sessionTabs: BrowserTabTarget[] = [];
  dashboardTarget?: BrowserDashboardTarget;
  available = true;
  isConnected = true;
  open = true;

  constructor(public client: GatewayBrowserClient | null) {
    const stage = this.stage;
    stage.className = "bp-stage";
    stubBrowserPanelTestStageBounds(stage);
    this.renderRoot.append(stage);
  }

  createPanel(): BrowserPanel {
    const panel = createBrowserPanel(this, this.notify);
    panel.input.elements.stage = this.stage;
    return panel;
  }

  browserPanelIsOpen(): boolean {
    return this.open;
  }
}

export function createView(targetId: string, url = "https://example.test/page"): BrowserPanelView {
  return {
    targetId,
    dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
    image: { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement,
    url,
    metrics: { cssWidth: 100, cssHeight: 100, title: BROWSER_PANEL_TEST_PAGE_TITLE, url },
  };
}

export function createBrowserPanelTestController(
  client: GatewayBrowserClient,
  targetId: string,
  url?: string,
): BrowserPanel {
  const controller = new TestBrowserPanelHost(client).createPanel();
  controller.activeTargetId = targetId;
  controller.view = createView(targetId, url);
  return controller;
}

export function createInspectedNode(name: string): BrowserInspectedNode {
  return {
    tag: "button",
    id: name,
    classes: [],
    role: "button",
    name,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    focusable: true,
  };
}

export function createPointer(x: number, y: number): PointerEvent {
  return new MouseEvent("pointermove", { clientX: x, clientY: y }) as PointerEvent;
}

export async function flushBrowserResponses(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

class TestBrowserImage extends EventTarget {
  naturalWidth = 100;
  naturalHeight = 100;
  private imageSource = "";

  set src(value: string) {
    this.imageSource = value;
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }

  get src(): string {
    return this.imageSource;
  }
}

class TestBrowserFileReader extends EventTarget {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      const binary = String.fromCharCode(...new Uint8Array(buffer));
      this.result = `data:${blob.type};base64,${btoa(binary)}`;
      this.dispatchEvent(new Event("load"));
    });
  }
}

export function stubScreenshotMedia(): void {
  vi.stubGlobal("Image", TestBrowserImage);
  vi.stubGlobal("FileReader", TestBrowserFileReader);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const text = url.includes("fresh") ? "fresh screenshot" : "old screenshot";
      return {
        ok: true,
        blob: async () => new Blob([text], { type: "image/png" }),
      } as Response;
    }),
  );
}

// Open the native action menu before querying its lazy entries.
export async function openBrowserActions(panel: HTMLElement) {
  const trigger = panel.querySelector<HTMLButtonElement>(
    '.bp-toolbar button[aria-haspopup="menu"]',
  )!;
  if (trigger.getAttribute("aria-expanded") !== "true") {
    trigger.click();
    await flushBrowserResponses();
  }
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
}
