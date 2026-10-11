import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { BoardWidgetFrameLifecycle } from "./board-widget-frame.ts";

let lifecycle: BoardWidgetFrameLifecycle | undefined;
const disposers: Array<() => void> = [];
function mountFrame(
  owner: BoardWidgetFrameLifecycle,
  widget: BoardWidget | (() => BoardWidget),
  root: HTMLElement,
) {
  const [revision, setRevision] = createSignal(0);
  disposers.push(mountSolid(() => owner.render(widget, revision), { container: root }).unmount);
  flush();
  return () => {
    setRevision((value) => value + 1);
    flush();
  };
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

it("resumes its board bridge after suspension rolls back without reconnecting", async () => {
  vi.useFakeTimers();
  const fetchDocument = vi.fn(async () => new Response("<p>Retained board</p>"));
  vi.stubGlobal("fetch", fetchDocument);
  const root = document.createElement("div");
  document.body.append(root);
  const request = vi.fn(async () => ({ value: "live" }));
  const context = {
    gateway: {
      snapshot: { phase: "connected", suspensionPhase: "accepting", client: { request } },
      connection: { gatewayUrl: "https://gateway.example" },
    },
  } as unknown as ApplicationContext;
  const widget: BoardWidget = {
    name: "weather",
    revision: 1,
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    viewTicket: "ticket",
    viewGeneration: "generation",
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 8444,
    sandboxOrigin: "https://sandbox.example",
  };
  const refresh = vi.fn(async () => {});
  lifecycle = new BoardWidgetFrameLifecycle({
    active: () => true,
    connected: () => root.isConnected,
    context: () => context,
    refreshFrame: () => refresh,
    requestUpdate: () => {},
    reportContentHeight: () => {},
    scrollBy: () => {},
    resolveFrameUrl: () => () => "/widget?bt=ticket",
    root: () => root,
    widget: () => widget,
  });
  mountFrame(lifecycle, widget, root);
  lifecycle.update();
  const frame = root.querySelector("iframe")!;
  const notify = (data: object, ports: MessagePort[] = []) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: new URL(frame.src).origin,
        data,
        ports,
      }),
    );
  notify({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } });
  await vi.advanceTimersByTimeAsync(0);
  const channel = new MessageChannel();
  onTestFinished(() => channel.port2.close());
  const initialized = Promise.withResolvers<void>();
  channel.port2.addEventListener("message", (event) => {
    if (event.data.type === "openclaw:widget-host-init") {
      channel.port2.postMessage({
        type: "openclaw:widget-host-init-ack",
        ticket: event.data.ticket,
      });
      initialized.resolve();
    }
  });
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
  lifecycle.update();
  await expect(read("paused")).resolves.toMatchObject({ ok: false });
  expect(request).toHaveBeenCalledOnce();
  context.gateway.snapshot.suspensionPhase = "accepting";
  lifecycle.update();
  await expect(read("resumed")).resolves.toMatchObject({ ok: true, result: { value: "live" } });
  expect(request).toHaveBeenCalledTimes(2);
  expect(root.querySelector("iframe")).toBe(frame);
  expect(fetchDocument).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps a stalled inner document mounted, offers retry, and accepts only the current render", async () => {
  vi.useFakeTimers();
  const fetchDocument = vi.fn(async () => new Response("<p>Weather</p>"));
  vi.stubGlobal("fetch", fetchDocument);
  const root = document.createElement("div");
  document.body.append(root);
  const widget: BoardWidget = {
    name: "weather",
    revision: 1,
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    viewTicket: "ticket",
    viewGeneration: "generation",
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 8444,
    sandboxOrigin: "https://sandbox.example",
  };
  const context = {
    gateway: {
      snapshot: { phase: "connected" },
      connection: { gatewayUrl: "https://gateway.example" },
    },
  } as ApplicationContext;
  let updateView = () => {};
  const update = () => {
    updateView();
    lifecycle!.update();
  };
  const refresh = vi.fn(async () => {});
  lifecycle = new BoardWidgetFrameLifecycle({
    active: () => true,
    connected: () => root.isConnected,
    context: () => context,
    refreshFrame: () => refresh,
    requestUpdate: update,
    reportContentHeight: () => {},
    scrollBy: () => {},
    resolveFrameUrl: () => () => "/widget?bt=ticket",
    root: () => root,
    widget: () => widget,
  });
  updateView = mountFrame(lifecycle, widget, root);
  update();
  const frame = root.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const notify = (method: string, params: object) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: new URL(frame.src).origin,
        data: { method, params },
      }),
    );
  notify("ui/notifications/sandbox-proxy-ready", { sandboxUrl: frame.src });
  await vi.advanceTimersByTimeAsync(0);
  const renderId = () =>
    post.mock.calls.findLast(
      ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
    )![0].params.renderId;
  const oldRender = renderId();
  await vi.advanceTimersByTimeAsync(30_000);
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
  expect(root.querySelector('[role="status"] button')).toBeNull();
});

it.each(["current", "revision", "replacement", "reconnect"] as const)(
  "publishes a failed refresh only for its admitted frame lifecycle (%s)",
  async (transition) => {
    let widget: BoardWidget = {
      name: "weather",
      revision: 1,
      tabId: "main",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
    };
    const refreshResult = createDeferred();
    const refreshFrame = vi.fn(() => refreshResult.promise);
    const root = document.createElement("div");
    document.body.append(root);
    let updateView = () => {};
    lifecycle = new BoardWidgetFrameLifecycle({
      active: () => true,
      connected: () => root.isConnected,
      context: () => undefined,
      refreshFrame: () => refreshFrame,
      requestUpdate: () => updateView(),
      reportContentHeight: () => {},
      scrollBy: () => {},
      resolveFrameUrl: () => (name, revision) => `/widget/${name}/${revision}`,
      root: () => root,
      widget: () => widget,
    });
    lifecycle.connect();
    updateView = mountFrame(lifecycle, () => widget, root);
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
