import { flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { boardWidget, gatewayContext } from "./board-view.test-support.ts";
import {
  acknowledgeWidgetHostInit,
  grantedFrameWidgetFixture,
  createFrameOwner,
  dispatchFrameMessage,
  mountBoardWidgetFrame,
} from "./board-widget-frame.test-support.tsx";
import type { BoardWidgetFrameOwner } from "./board-widget-frame.tsx";

let lifecycle: BoardWidgetFrameOwner | undefined;
const disposers: Array<() => void> = [];
function mountFrame(
  widget: BoardWidget,
  context: ApplicationContext,
  overrides: Parameters<typeof createFrameOwner>[1] = {},
  subscribe = false,
) {
  const fetchDocument = vi.fn(async () => new Response("<p>Dashboard</p>"));
  vi.stubGlobal("fetch", fetchDocument);
  const root = document.createElement("div");
  document.body.append(root);
  const refresh = vi.fn(async () => {});
  lifecycle = createFrameOwner(() => widget, {
    connected: () => root.isConnected,
    context: () => context,
    refreshFrame: () => refresh,
    resolveFrameUrl: () => () => "/widget?bt=ticket",
    ...overrides,
  });
  if (subscribe) {
    onTestFinished(lifecycle.subscribe(() => lifecycle?.update()));
  }
  mountBoardWidgetFrame(lifecycle, widget, root, disposers);
  lifecycle.update();
  const frame = root.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const notify = (data: object, ports: MessagePort[] = []) =>
    dispatchFrameMessage(frame, { origin: new URL(frame.src).origin, data, ports });
  notify({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } });
  return { root, frame, post, notify, fetchDocument, refresh };
}
afterEach(() => {
  lifecycle?.disconnect();
  lifecycle = undefined;
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  { phase: "connecting", ttl: 60_000, active: true, fetches: 1 },
  { phase: "connecting", ttl: 0, active: true, fetches: 0 },
  { phase: "offline", ttl: 60_000, active: true, fetches: 0 },
  { phase: "connecting", ttl: 60_000, active: false, fetches: 0 },
] as const)(
  "loads a warm document only with a live ticket and presented initial connection ($phase, $ttl, $active)",
  async ({ phase, ttl, active, fetches }) => {
    vi.useFakeTimers();
    const context = gatewayContext(null);
    context.gateway.snapshot.phase = phase;
    const widget = boardWidget({
      viewTicket: "cached-ticket",
      viewTicketTtlMs: ttl,
      sandboxUrl: "/mcp-app-sandbox",
      sandboxPort: 8444,
      sandboxOrigin: "https://sandbox.example",
    });
    const { fetchDocument, post: deliver } = mountFrame(widget, context, {
      active: () => active,
      refreshFrame: () => undefined,
      resolveFrameUrl: () => () => "/widget?bt=cached-ticket",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchDocument).toHaveBeenCalledTimes(fetches);
    expect(
      deliver.mock.calls.filter(
        ([message]) => message.method === "ui/notifications/sandbox-resource-ready",
      ),
    ).toHaveLength(fetches);
  },
);

it("resumes its board bridge after suspension rolls back without reconnecting", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ value: "live" }));
  const context = {
    gateway: {
      snapshot: { phase: "connected", suspensionPhase: "accepting", client: { request } },
      connection: { gatewayUrl: "https://gateway.example" },
    },
  } as unknown as ApplicationContext;
  const { root, frame, notify, fetchDocument, refresh } = mountFrame(
    grantedFrameWidgetFixture(),
    context,
  );
  await vi.advanceTimersByTimeAsync(0);
  const channel = new MessageChannel();
  onTestFinished(() => channel.port2.close());
  const initialized = Promise.withResolvers<void>();
  acknowledgeWidgetHostInit(channel.port2, initialized);
  channel.port2.start();
  notify({ type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
  await initialized.promise;
  const read = (id: string) =>
    new Promise<unknown>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data.id === id && event.data.type === "openclaw:widget-bridge-response") {
          channel.port2.removeEventListener("message", listener);
          resolve(event.data);
        }
      };
      channel.port2.addEventListener("message", listener);
      channel.port2.postMessage({
        type: "openclaw:widget-bridge-request",
        id,
        method: "data.read",
        params: { bindingId: "weather" },
        ticket: "ticket",
      });
    });
  await expect(read("initial")).resolves.toMatchObject({ ok: true });
  context.gateway.snapshot.suspensionPhase = "preparing";
  lifecycle!.update();
  await expect(read("paused")).resolves.toMatchObject({ ok: false });
  expect(request).toHaveBeenCalledOnce();
  context.gateway.snapshot.suspensionPhase = "accepting";
  lifecycle!.update();
  await expect(read("resumed")).resolves.toMatchObject({ ok: true, result: { value: "live" } });
  expect(request).toHaveBeenCalledTimes(2);
  expect(root.querySelector("iframe")).toBe(frame);
  expect(fetchDocument).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps a stalled inner document mounted, offers retry, and accepts only the current render", async () => {
  vi.useFakeTimers();
  const context = {
    gateway: {
      snapshot: { phase: "connected" },
      connection: { gatewayUrl: "https://gateway.example" },
    },
  } as ApplicationContext;
  const {
    root,
    frame,
    post,
    notify: dispatch,
    fetchDocument,
    refresh,
  } = mountFrame(grantedFrameWidgetFixture(), context, {}, true);
  const notify = (method: string, params: object) => dispatch({ method, params });
  await vi.advanceTimersByTimeAsync(0);
  const renderId = () =>
    post.mock.calls.findLast(
      ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
    )![0].params.renderId;
  const oldRender = renderId();
  expect(frame.style.opacity).toBe("");
  expect(frame.hasAttribute("inert")).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(frame.style.opacity).toBe("0");
  expect(root.querySelector("iframe")).toBe(frame);
  expect(root.querySelector('[role="alert"]')).toBeNull();
  const retry = root.querySelector<HTMLButtonElement>('[role="status"] button');
  expect(retry?.textContent).toContain("Retry");
  retry!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchDocument).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
  notify("ui/notifications/sandbox-resource-loaded", { renderId: oldRender });
  await vi.advanceTimersByTimeAsync(40);
  expect(frame.style.opacity).toBe("0");
  notify("ui/notifications/sandbox-resource-loaded", { renderId: renderId() });
  await vi.advanceTimersByTimeAsync(40);
  expect(root.querySelector("iframe")).toBe(frame);
  expect(frame.style.opacity).toBe("");
  expect(frame.hasAttribute("inert")).toBe(false);
  expect(root.querySelector('[role="status"] button')).toBeNull();
});

it.each(["current", "revision", "replacement", "reconnect"] as const)(
  "publishes a failed refresh only for its admitted frame lifecycle (%s)",
  async (transition) => {
    let widget = boardWidget({ name: "weather", grantState: "none" });
    const refreshResult = createDeferred();
    const refreshFrame = vi.fn(() => refreshResult.promise);
    const root = document.createElement("div");
    document.body.append(root);
    lifecycle = createFrameOwner(() => widget, {
      connected: () => root.isConnected,
      refreshFrame: () => refreshFrame,
      resolveFrameUrl: () => (name, revision) => `/widget/${name}/${revision}`,
    });
    lifecycle.connect();
    const updateView = mountBoardWidgetFrame(lifecycle, () => widget, root, disposers);
    const frame = root.querySelector("iframe")!;
    frame.dispatchEvent(new Event("error"));
    expect(refreshFrame).toHaveBeenCalledExactlyOnceWith("weather");

    if (transition === "reconnect") {
      lifecycle.disconnect();
      lifecycle.connect();
    } else if (transition !== "current") {
      const previous = widget;
      widget =
        transition === "revision" ? { ...widget, revision: 2 } : { ...widget, name: "stocks" };
      lifecycle.widgetChanged(previous, widget);
      updateView();
    }
    refreshResult.reject(new Error("Retired refresh failed"));
    await refreshResult.promise.catch(() => undefined);
    await Promise.resolve();
    flush();

    expect(lifecycle.error).toBe(transition === "current" ? "Retired refresh failed" : "");
    expect(root.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(`/widget/${widget.name}/${widget.revision}`);
  },
);
