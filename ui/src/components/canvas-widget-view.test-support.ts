import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { GatewayEventListener } from "../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationContextRequest,
} from "../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  bumpCanvasWidgetFrameConnectionGeneration,
  getCanvasWidgetFrameConnectionGeneration,
} from "../lib/chat/canvas-widget-frame-generation.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { CanvasWidgetView, type OpenClawCanvasWidgetView } from "./canvas-widget-view.tsx";

export const repeat = (length: number) => "x".repeat(length);
export const elementName = "openclaw-canvas-widget-view";
export const documentView: CanvasDocumentViewResult = {
  html: "<p>Widget ready</p>",
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};
type WidgetClient = {
  request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
};
export let client: WidgetClient;

type WidgetGatewaySnapshot = Omit<Partial<ApplicationGatewaySnapshot>, "client"> & {
  client: WidgetClient;
};

export const gateways = new WeakMap<
  OpenClawCanvasWidgetView,
  {
    snapshot: WidgetGatewaySnapshot;
    connectionRevision: number;
    notify: () => void;
    emit: GatewayEventListener;
    eventListeners: Set<GatewayEventListener>;
  }
>();

export async function settle(view: OpenClawCanvasWidgetView) {
  for (let i = 0; i < 4; i += 1) {
    await view.updateComplete;
    await Promise.resolve();
    flush();
  }
}

export function connection(
  view: OpenClawCanvasWidgetView,
  phase: ApplicationGatewaySnapshot["phase"],
  patch: Partial<ApplicationGatewaySnapshot> = {},
) {
  const gateway = gateways.get(view)!;
  bumpCanvasWidgetFrameConnectionGeneration();
  view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
  Object.assign(gateway.snapshot, { phase }, patch);
  gateway.notify();
}

export async function transition(
  view: OpenClawCanvasWidgetView,
  phase: ApplicationGatewaySnapshot["phase"],
  patch?: Partial<ApplicationGatewaySnapshot>,
) {
  connection(view, phase, patch);
  await settle(view);
}

export function mount(
  widgetClient: WidgetClient = client,
  docId = "cv_inline",
  parent: Element | ShadowRoot = document.body,
  operatorScopes?: string[],
) {
  const view = new CanvasWidgetView.Element();
  const listeners = new Set<GatewayEventListener>();
  const gateway = {
    snapshot: {
      client: widgetClient,
      phase: "connected",
      ...(operatorScopes
        ? { hello: gatewayHelloForMethods(["canvas.document.view"], operatorScopes) }
        : {}),
    } as WidgetGatewaySnapshot,
    connection: { gatewayUrl: "ws://gateway.example:8443" },
    connectionRevision: 0,
    notify: () => {},
    eventListeners: listeners,
    emit: ((event) => {
      // The Gateway snapshots its event subscribers before delivery.
      const delivery = [...listeners];
      for (const listener of delivery) {
        listener(event);
      }
    }) as GatewayEventListener,
    subscribeEvents: (listener: GatewayEventListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribe: (notify: () => void) => {
      gateway.notify = notify;
      return () => {};
    },
  };
  gateways.set(view, gateway);
  view.addEventListener("context-request", (event) => {
    // SAFETY: This listener handles the native application context protocol.
    const contextRequest = event as ApplicationContextRequest;
    if (contextRequest.context === applicationContext) {
      event.stopPropagation();
      contextRequest.callback({
        gateway,
        sessions: {
          subscribeMessages: async (key: string) => ({ key }),
          unsubscribeMessages: async () => {},
        },
      } as unknown as ApplicationContext);
    }
  });
  view.docId = docId;
  view.sessionKey = "agent:main:widget-test";
  view.messageTimestamp = Date.now();
  view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
  const container = document.createElement("div");
  parent.append(container);
  mountSolid(() => view, { container });
  return view;
}

export async function frameFor(view: OpenClawCanvasWidgetView): Promise<HTMLIFrameElement> {
  const frame = view.querySelector("iframe");
  if (frame) {
    return frame;
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const nextFrame = view.querySelector("iframe");
      if (nextFrame) {
        observer.disconnect();
        resolve(nextFrame);
      }
    });
    observer.observe(view, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
  });
}

export function message(
  frame: HTMLIFrameElement,
  data: unknown,
  ports: MessagePort[] = [],
  origin?: string,
  source: MessageEventSource | null = frame.contentWindow,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source,
      origin: origin ?? new URL(frame.src).origin,
      data,
      ports,
    }),
  );
}

export async function loaded(docId = "cv_inline", parent: Element | ShadowRoot = document.body) {
  const view = mount(client, docId, parent);
  const frame = await frameFor(view);
  await settle(view);
  return { view, frame };
}

export function proxyReady(frame: HTMLIFrameElement) {
  message(frame, {
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl: frame.src },
  });
}

export function expectRead(widgetClient: WidgetClient, docId: string) {
  expect(widgetClient.request).toHaveBeenLastCalledWith(
    "canvas.document.view",
    { docId },
    { timeoutMs: 30_000 },
  );
}

export function expectRecovering(view: OpenClawCanvasWidgetView) {
  expect(alert(view)).toBeNull();
  expect(notice(view)).toContain("recover automatically");
}

export const alert = (view: Element) => view.querySelector('[role="alert"]');
export const notice = (view: Element) => view.querySelector('[role="status"]')?.textContent;
export function commitWidget(view: OpenClawCanvasWidgetView, sessionKey = view.sessionKey) {
  gateways.get(view)!.emit({
    type: "event",
    event: "session.message",
    payload: { sessionKey, message: { role: "toolResult", toolName: "show_widget" } },
  });
}

export function setupCanvasWidgetTests() {
  beforeEach(() => {
    client = { request: vi.fn().mockResolvedValue(documentView) };
  });
  afterEach(() => {
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}
