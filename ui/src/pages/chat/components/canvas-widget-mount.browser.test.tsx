import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import "../../../components/canvas-widget-view.tsx";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { createSessionScopedOperations } from "../../../lib/sessions/session-scoped-operations.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../../test-helpers/solid-application-context.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { CanvasWidgetMount } from "./canvas-widget-mount.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each(["commit", "retirement"])(
  "keeps a parked shared-reader widget subscribed until %s",
  async (outcome) => {
    const key = "agent:main:shared-widget";
    const subscriptions = new Set<string>();
    let committed = false;
    const documentView: CanvasDocumentViewResult = {
      html: "<p>Committed widget</p>",
      sandboxUrl: "/mcp-app-sandbox?frames=none",
      sandboxPort: 8444,
    };
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.messages.subscribe") {
        subscriptions.add(String(params?.subscriptionId));
        return { key };
      }
      if (method === "sessions.messages.unsubscribe") {
        subscriptions.delete(String(params?.subscriptionId));
        return {};
      }
      if (method === "canvas.document.view") {
        if (committed) {
          return documentView;
        }
        throw new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Waiting for the widget result.",
          retryable: true,
          details: { type: "canvas_widget_pending" },
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    // SAFETY: This fixture implements the request transport used by the real subscription owner.
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createApplicationGateway();
    gateway.publish({
      ...gateway.gateway.snapshot,
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["canvas.document.view"], ["operator.sessions.read"]),
    });
    const scope = { client, epoch: 0 };
    const sessions = createSessionScopedOperations({
      connection: { capture: () => scope, isCurrent: (captured) => captured === scope },
      reconcileMutation: async () => ({ status: "stale" }),
      notifyCreated: () => {},
      reportError: () => {},
    });
    // SAFETY: The widget consumes only these two application capabilities.
    const context = {
      gateway: gateway.gateway,
      sessions,
    } as unknown as ApplicationContext;
    const paneSubscription = await sessions.subscribeMessages(key);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [row, setRow] = createSignal("pending");
    const onElement = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = mountSolid(
      () => (
        <ApplicationProvider value={context} host={container}>
          <Show when={row()} keyed>
            {(_row) => (
              <CanvasWidgetMount
                docId="cv_parked"
                sessionKey={key}
                title="Shared widget"
                allowScripts={false}
                connectionGeneration={0}
                onElement={onElement}
              />
            )}
          </Show>
        </ApplicationProvider>
      ),
      { container },
    );
    flush();
    const widget = root.container.querySelector<OpenClawCanvasWidgetView>(
      "openclaw-canvas-widget-view",
    )!;
    expect(onElement).toHaveBeenLastCalledWith(widget);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(widget.textContent).toContain("Waiting for the widget result");
    setRow("");
    flush();
    expect(onElement).toHaveBeenLastCalledWith(undefined);
    expect(widget.isConnected).toBe(true);
    expect(widget.presentationActive).toBe(false);
    await sessions.unsubscribeMessages(paneSubscription);
    expect(subscriptions.size).toBe(1);
    if (outcome === "retirement") {
      await vi.advanceTimersByTimeAsync(1_001);
      expect(widget.isConnected).toBe(false);
      expect(subscriptions.size).toBe(0);
      root.unmount();
      sessions.dispose();
      return;
    }
    committed = true;
    gateway.publishEvent({
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: key,
        ...(subscriptions.size > 0
          ? { message: { role: "toolResult", toolName: "show_widget" } }
          : {}),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(widget.documentHtml).toBe(documentView.html);
    expect(subscriptions.size).toBe(0);
    setRow("committed");
    flush();
    expect(onElement.mock.calls).toEqual([[widget], [undefined], [widget]]);
    expect(root.container.querySelector("openclaw-canvas-widget-view")).toBe(widget);
    const frame = widget.querySelector("iframe")!;
    expect(frame.srcdoc).toBe(documentView.html);
    expect(request.mock.calls.filter(([method]) => method === "canvas.document.view")).toHaveLength(
      2,
    );
    frame.style.width = "100%";
    frame.style.boxSizing = "border-box";
    const bounds = frame.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    root.unmount();
    expect(onElement).toHaveBeenLastCalledWith(undefined);
    expect(frame.isConnected).toBe(true);
    expect(frame.getBoundingClientRect().width).toBe(bounds.width);
    expect(frame.getBoundingClientRect().height).toBe(bounds.height);
    vi.advanceTimersByTime(1_001);
    expect(frame.isConnected).toBe(false);
    sessions.dispose();
  },
);
