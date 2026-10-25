/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { BoardWidget } from "../../lib/board/types.ts";
import { recordBoardWidgetTicketReceipt } from "../../lib/board/widget-ticket-lifetime.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { WIDGET_PROMPT_EVENT } from "../mcp-app-security.ts";
import { boardWidget, gatewayContext } from "./board-view.test-support.ts";
import {
  acknowledgeWidgetHostInit,
  createFrameOwner,
  dispatchFrameMessage,
  mountBoardWidgetFrame,
} from "./board-widget-frame.test-support.tsx";
import type { BoardWidgetFrameOwner } from "./board-widget-frame.tsx";

const disposers: Array<() => void> = [];

function createTicketRefreshLifecycle(
  widget: BoardWidget,
  refreshFrame: (name: string) => Promise<void>,
): BoardWidgetFrameOwner {
  const lifecycle = createFrameOwner(() => widget, { refreshFrame: () => refreshFrame });
  lifecycle.connect();
  lifecycle.update();
  return lifecycle;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMode;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("board widget frame visibility lifetime", () => {
  it("shares one native listener until the final active owner retires", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    let firstActive = true;
    const owners = Array.from({ length: 6 }, (_, index) => {
      const owner = createFrameOwner(() => boardWidget({ name: `clock-${index}` }), {
        active: () => index !== 0 || firstActive,
      });
      disposers.push(() => owner.disconnect());
      owner.connect();
      owner.connect();
      owner.update();
      return owner;
    });
    expect(add.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);

    firstActive = false;
    owners[0]!.activityChanged();
    expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
    firstActive = true;
    owners[0]!.activityChanged();
    expect(add.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);

    for (const owner of owners.slice(0, -1)) {
      owner.disconnect();
    }
    expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
    owners.at(-1)!.disconnect();
    expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  });
});

describe("board widget frame message lifetime", () => {
  it("does not listen for frame messages when active cells have no iframe", () => {
    const add = vi.spyOn(window, "addEventListener");
    for (let index = 0; index < 6; index += 1) {
      const owner = createFrameOwner(() =>
        boardWidget({ name: `progress-${index}`, contentKind: "plugin" }),
      );
      disposers.push(() => owner.disconnect());
      owner.connect();
      owner.update();
    }
    expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
  });

  it("shares delivery between mounted frames and retains suspended frame registration", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const firstHeight = vi.fn();
    const secondHeight = vi.fn();
    let firstActive = true;
    const mountFrame = (name: string, reportContentHeight: typeof firstHeight) => {
      const widget = boardWidget({ name });
      const owner = createFrameOwner(() => widget, {
        active: () => name !== "first" || firstActive,
        reportContentHeight,
      });
      disposers.push(() => owner.disconnect());
      owner.connect();
      const root = document.body.appendChild(document.createElement("div"));
      mountBoardWidgetFrame(owner, widget, root, disposers);
      return { owner, frame: root.querySelector("iframe")! };
    };
    const first = mountFrame("first", firstHeight);
    const second = mountFrame("second", secondHeight);
    expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
    dispatchFrameMessage(first.frame, { data: { type: "openclaw:widget-size", height: 360 } });
    expect(firstHeight).toHaveBeenCalledExactlyOnceWith("first", 360);
    expect(secondHeight).not.toHaveBeenCalled();
    firstActive = false;
    first.owner.activityChanged();
    dispatchFrameMessage(first.frame, { data: { type: "openclaw:widget-size", height: 480 } });
    expect(firstHeight).toHaveBeenCalledOnce();
    expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
    firstActive = true;
    first.owner.activityChanged();
    first.owner.disconnect();
    dispatchFrameMessage(first.frame, { data: { type: "openclaw:widget-size", height: 640 } });
    dispatchFrameMessage(second.frame, { data: { type: "openclaw:widget-size", height: 720 } });
    expect(firstHeight).toHaveBeenCalledOnce();
    expect(secondHeight).toHaveBeenCalledExactlyOnceWith("second", 720);
    expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
    second.owner.disconnect();
    expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
  });

  it("retires a replaced iframe source before accepting messages from its replacement", () => {
    let widget = boardWidget();
    const reportContentHeight = vi.fn();
    const owner = createFrameOwner(() => widget, {
      context: () => gatewayContext(null),
      reportContentHeight,
    });
    disposers.push(() => owner.disconnect());
    owner.connect();
    const root = document.body.appendChild(document.createElement("div"));
    const update = mountBoardWidgetFrame(owner, () => widget, root, disposers);
    const previous = root.querySelector("iframe")!;
    const retiredSource = previous.contentWindow;
    widget = {
      ...widget,
      sandboxUrl: "/mcp-app-sandbox",
      sandboxOrigin: "https://sandbox.example",
      sandboxPort: 18790,
      viewTicket: "ticket",
    };
    update();
    const current = root.querySelector("iframe")!;
    expect(current).not.toBe(previous);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: retiredSource,
        data: { type: "openclaw:widget-size", height: 360 },
      }),
    );
    expect(reportContentHeight).not.toHaveBeenCalled();
    dispatchFrameMessage(current, { data: { type: "openclaw:widget-size", height: 480 } });
    expect(reportContentHeight).toHaveBeenCalledExactlyOnceWith(widget.name, 480);
  });
});

function terminalFailureError(params: {
  widget: Partial<BoardWidget>;
  resolvedSandboxOrigin: string;
}): string {
  const widget = boardWidget({
    name: "clock",
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: Number(new URL(params.resolvedSandboxOrigin).port) || 443,
    viewTicket: "ticket",
    ...params.widget,
  });
  const context = gatewayContext(null);
  const gatewayUrl = new URL(params.resolvedSandboxOrigin);
  gatewayUrl.port = "18789";
  context.gateway.connection.gatewayUrl = gatewayUrl.href;
  const root = document.createElement("div");
  document.body.append(root);
  const owner = createFrameOwner(() => widget, {
    connected: () => root.isConnected,
    context: () => context,
    refreshFrame: () => async () => {},
    resolveFrameUrl: () => () => "/widget?bt=ticket",
  });
  mountBoardWidgetFrame(owner, widget, root, disposers);
  const frame = root.querySelector("iframe")!;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    frame.dispatchEvent(new Event("error"));
  }
  return owner.error;
}

describe("board widget frame terminal failure message", () => {
  it("points at mcp.apps.sandboxOrigin when a derived remote sandbox origin fails", () => {
    const message = terminalFailureError({
      widget: {},
      resolvedSandboxOrigin: "https://team.example.com:18790",
    });
    expect(message).toContain("mcp.apps.sandboxOrigin");
  });

  it("keeps the authorization message when a sandbox origin is explicitly configured", () => {
    const message = terminalFailureError({
      widget: { sandboxOrigin: "https://widgets.example.com" },
      resolvedSandboxOrigin: "https://widgets.example.com",
    });
    expect(message).toContain("authorization failed");
    expect(message).not.toContain("mcp.apps.sandboxOrigin");
  });

  it("keeps the authorization message for loopback sandbox hosts", () => {
    for (const origin of [
      "http://localhost:18790",
      "http://127.0.0.1:18790",
      "http://127.0.0.5:18790",
      "http://[::1]:18790",
    ]) {
      const message = terminalFailureError({ widget: {}, resolvedSandboxOrigin: origin });
      expect(message).toContain("authorization failed");
      expect(message).not.toContain("mcp.apps.sandboxOrigin");
    }
  });
});

describe("board widget frame themes", () => {
  it.each(["light", "dark"] as const)(
    "seeds the sandbox's %s first paint and changes theme without navigating",
    async (mode) => {
      document.documentElement.dataset.themeMode = mode;
      const widget = boardWidget({
        sandboxUrl: "/mcp-app-sandbox?v=version&csp=policy",
        sandboxOrigin: "https://sandbox.example",
        sandboxPort: 18790,
        viewTicket: "ticket",
      });
      const root = document.createElement("div");
      document.body.append(root);
      const owner = createFrameOwner(() => widget, {
        connected: () => root.isConnected,
        context: () => gatewayContext(null),
        resolveFrameUrl: () => () => "/widget?bt=ticket",
      });
      disposers.push(() => owner.disconnect());
      const update = mountBoardWidgetFrame(owner, widget, root, disposers);
      const frame = root.querySelector("iframe")!;
      const source = frame.src;
      expect(source).toBe(
        `https://sandbox.example/mcp-app-sandbox?v=version&csp=policy#theme=${mode}`,
      );
      expect(frame.style.colorScheme).toBe(mode);
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      owner.postBoardHostState(frame);

      const next = mode === "light" ? "dark" : "light";
      document.documentElement.dataset.themeMode = next;
      await Promise.resolve();
      update();
      expect(frame.style.colorScheme).toBe(next);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "openclaw:widget-theme", mode: next }),
        "https://sandbox.example",
      );
      expect(frame.src).toBe(source);

      widget.sandboxUrl = "/mcp-app-sandbox?v=next-version&csp=next-policy";
      update();
      expect(root.querySelector("iframe")).toBe(frame);
      expect(frame.src).toBe(
        `https://sandbox.example/mcp-app-sandbox?v=next-version&csp=next-policy#theme=${next}`,
      );
      expect(frame.style.colorScheme).toBe(next);
    },
  );

  it("delivers theme changes to its frame until the owner disconnects", async () => {
    const widget = boardWidget({ name: "theme" });
    const owner = createTicketRefreshLifecycle(widget, async () => {});
    disposers.push(() => owner.disconnect());
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    owner.bindFrame(frame);
    owner.postBoardHostState(frame);
    post.mockClear();

    document.documentElement.dataset.themeMode = "light";
    await Promise.resolve();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
      "*",
    );

    owner.disconnect();
    post.mockClear();
    document.documentElement.dataset.themeMode = "dark";
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("board widget frame scroll handoff", () => {
  it.each([true, false])(
    "reissues scroll authority after document rendering while active=%s",
    async (activeAtReady) => {
      let active = true;
      const scrollBy = vi.fn();
      const widget = boardWidget({
        name: "long-dashboard",
        sandboxUrl: "/mcp-app-sandbox",
        sandboxOrigin: "https://sandbox.example",
        sandboxPort: 18790,
        viewTicket: "ticket",
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>Saved dashboard</p>"));
      const context = gatewayContext(null);
      const container = document.createElement("div");
      document.body.append(container);
      const lifecycle = createFrameOwner(() => widget, {
        active: () => active,
        context: () => context,
        scrollBy,
        resolveFrameUrl: () => () => "/__openclaw__/board/long-dashboard?bt=ticket",
      });
      lifecycle.connect();
      mountBoardWidgetFrame(lifecycle, widget, container, disposers);
      const frame = container.querySelector<HTMLIFrameElement>(".board-widget__frame")!;
      const resourceReady = createDeferred<{ renderId: string }>();
      const hostNonces: string[] = [];
      vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
        if (message.type === "openclaw:widget-board-host") {
          hostNonces.push(message.nonce);
        } else if (message.method === "ui/notifications/sandbox-resource-ready") {
          resourceReady.resolve(message.params);
        }
      });
      const receive = (data: object) =>
        dispatchFrameMessage(frame, { origin: "https://sandbox.example", data });
      try {
        frame.dispatchEvent(new Event("load"));
        const initialNonce = hostNonces.at(-1);
        expect(initialNonce).toEqual(expect.any(String));
        lifecycle.update();
        receive({
          method: "ui/notifications/sandbox-proxy-ready",
          params: { sandboxUrl: frame.src },
        });
        const { renderId } = await resourceReady.promise;
        if (!activeAtReady) {
          active = false;
          lifecycle.activityChanged();
        }
        receive({
          method: "ui/notifications/sandbox-resource-loaded",
          params: { renderId },
        });
        expect(hostNonces.at(-1)).not.toBe(initialNonce);
        if (!activeAtReady) {
          active = true;
          lifecycle.activityChanged();
        }
        receive({ type: "openclaw:widget-scroll", deltaY: 96, nonce: initialNonce });
        expect(scrollBy).not.toHaveBeenCalled();
        receive({ type: "openclaw:widget-scroll", deltaY: 48, nonce: hostNonces.at(-1) });
        expect(scrollBy).toHaveBeenCalledExactlyOnceWith(48);
      } finally {
        lifecycle.disconnect();
      }
    },
  );

  it("accepts a finite vertical remainder only from its rendered iframe and nonce", () => {
    const widget = { name: "long-dashboard", revision: 1 } as BoardWidget;
    const scrollBy = vi.fn();
    const lifecycle = createFrameOwner(() => widget, { scrollBy });
    const unrelated = document.createElement("iframe");
    unrelated.className = "board-widget__frame";
    const root = document.createElement("div");
    document.body.append(unrelated, root);
    mountBoardWidgetFrame(lifecycle, widget, root, disposers);
    const frame = root.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    frame.dispatchEvent(new Event("load"));
    const nonce = post.mock.calls.find(([data]) => data.type === "openclaw:widget-board-host")![0]
      .nonce;
    lifecycle.connect();

    dispatchFrameMessage(frame, { data: { type: "openclaw:widget-scroll", deltaY: 48, nonce } });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "openclaw:widget-scroll", deltaY: 96, nonce },
      }),
    );
    dispatchFrameMessage(frame, {
      data: {
        type: "openclaw:widget-scroll",
        deltaY: Number.POSITIVE_INFINITY,
        nonce,
      },
    });
    dispatchFrameMessage(frame, {
      data: { type: "openclaw:widget-scroll", deltaY: 192, nonce: "wrong-nonce" },
    });

    expect(scrollBy).toHaveBeenCalledOnce();
    expect(scrollBy).toHaveBeenCalledWith(48);
    const source = frame.contentWindow;
    root.remove();
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { type: "openclaw:widget-scroll", deltaY: 96, nonce },
      }),
    );
    expect(scrollBy).toHaveBeenCalledOnce();
    lifecycle.disconnect();
  });
});

describe("board widget frame message confirmation", () => {
  it("confirms private-bridge prompts in the widget strip before dispatching", async () => {
    vi.useFakeTimers();
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>Parts dashboard</p>"));
    const widget = boardWidget({
      name: "confirm-parts",
      title: "Parts dashboard",
      sandboxUrl: "/mcp-app-sandbox",
      sandboxOrigin: "https://sandbox.example",
      sandboxPort: 18790,
      viewTicket: "ticket",
    });
    const request = vi.fn(async () => ({ confirmationRequired: true }));
    const context = gatewayContext({ request });
    const root = document.createElement("div");
    document.body.append(root);
    let active = true;
    const lifecycle = createFrameOwner(() => widget, {
      active: () => active,
      connected: () => root.isConnected,
      context: () => context,
      resolveFrameUrl: () => () => "/__openclaw__/board/confirm-parts?bt=ticket",
    });
    lifecycle.connect();
    mountBoardWidgetFrame(lifecycle, widget, root, disposers);
    lifecycle.update();
    const frame = root.querySelector<HTMLIFrameElement>("iframe")!;
    frame.checkVisibility = () => true;
    const resourceReady = createDeferred<{ renderId: string }>();
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
      if (message.method === "ui/notifications/sandbox-resource-ready") {
        resourceReady.resolve(message.params);
      }
    });
    const notify = (data: object, ports: MessagePort[] = []) =>
      dispatchFrameMessage(frame, { origin: "https://sandbox.example", data, ports });
    const channel = new MessageChannel();
    const initialized = createDeferred();
    acknowledgeWidgetHostInit(channel.port2, initialized);
    channel.port2.start();
    const send = (id: string, text: string) => {
      const response = createDeferred<Record<string, unknown>>();
      const receive = (event: MessageEvent) => {
        if (event.data.type === "openclaw:widget-bridge-response" && event.data.id === id) {
          channel.port2.removeEventListener("message", receive);
          response.resolve(event.data as Record<string, unknown>);
        }
      };
      channel.port2.addEventListener("message", receive);
      channel.port2.postMessage({
        type: "openclaw:widget-bridge-request",
        id,
        method: "prompt.send",
        params: { text },
        ticket: "ticket",
      });
      return response.promise;
    };
    const received: unknown[] = [];
    root.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
      received.push((event as CustomEvent<unknown>).detail);
    });
    try {
      notify({ method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } });
      const { renderId } = await resourceReady.promise;
      notify({ method: "ui/notifications/sandbox-resource-loaded", params: { renderId } });
      await vi.advanceTimersByTimeAsync(32);
      notify({ type: "openclaw:widget-bridge-port-offer" }, [channel.port1]);
      await initialized.promise;
      frame.focus();
      const cancelled = send("cancelled", "Compare these parts");
      await Promise.race([
        waitForSolid(() => expect(root.querySelector('[role="alertdialog"]')).not.toBeNull()),
        cancelled,
      ]);
      const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain("Parts dashboard");
      expect(dialog!.textContent).toContain("Send this message to the assistant?");
      expect(dialog!.textContent).toContain("Compare these parts");
      expect(received).toHaveLength(0);
      [...dialog!.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      await expect(cancelled).resolves.toMatchObject({ ok: false });
      expect(received).toHaveLength(0);
      expect(root.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.activeElement).toBe(frame);

      const accepted = send("accepted", "Order the selected parts");
      await Promise.race([
        waitForSolid(() => expect(root.querySelector('[role="alertdialog"]')).not.toBeNull()),
        accepted,
      ]);
      [...root.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((button) => button.textContent?.trim() === "Send")!
        .click();
      await expect(accepted).resolves.toMatchObject({ ok: true, result: { ok: true } });
      expect(received).toEqual([{ text: "Order the selected parts" }]);
      expect(request).toHaveBeenCalledWith("board.prompt.authorize", { ticket: "ticket" });
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(root.querySelector('[role="alertdialog"]')).toBeNull();

      const suspended = send("suspended", "This request loses its active widget");
      await Promise.race([
        waitForSolid(() => expect(root.querySelector('[role="alertdialog"]')).not.toBeNull()),
        suspended,
      ]);
      const staleSend = [
        ...root.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
      ].find((button) => button.textContent?.trim() === "Send")!;
      active = false;
      lifecycle.activityChanged();
      staleSend.click();
      await expect(suspended).resolves.toMatchObject({ ok: false });
      expect(received).toEqual([{ text: "Order the selected parts" }]);
      expect(root.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      lifecycle.disconnect();
      channel.port2.close();
    }
  });
});

describe("board widget frame ticket refresh", () => {
  it("refreshes an already-expired restored ticket", async () => {
    vi.useFakeTimers();
    const refreshFrame = vi.fn(async () => undefined);
    const widget = boardWidget({
      name: "expired",
      viewTicket: "expired-ticket",
      viewTicketTtlMs: 0,
    });
    recordBoardWidgetTicketReceipt(widget);
    const lifecycle = createTicketRefreshLifecycle(widget, refreshFrame);
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(refreshFrame).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshFrame).toHaveBeenCalledExactlyOnceWith("expired");
    } finally {
      lifecycle.disconnect();
    }
  });

  it("pauses ticket refresh while inactive and retains its frame on activation", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>Retained board</p>"));
    let active = true;
    const refreshFrame = vi.fn(async () => undefined);
    const reportContentHeight = vi.fn();
    const widget = boardWidget({
      name: "clock",
      sandboxUrl: "/mcp-app-sandbox",
      sandboxPort: 18790,
      sandboxOrigin: "https://sandbox.example",
      viewTicket: "ticket",
      viewTicketTtlMs: 30_000,
    });
    recordBoardWidgetTicketReceipt(widget);
    const root = document.createElement("div");
    document.body.append(root);
    const context = gatewayContext(null);
    const owner = createFrameOwner(() => widget, {
      active: () => active,
      connected: () => root.isConnected,
      context: () => context,
      refreshFrame: () => refreshFrame,
      reportContentHeight,
      resolveFrameUrl: () => () => "/widget?bt=ticket",
    });
    mountBoardWidgetFrame(owner, widget, root, disposers);
    owner.update();
    const frame = root.querySelector("iframe")!;
    const reportHeight = () =>
      dispatchFrameMessage(frame, {
        origin: "https://sandbox.example",
        data: { type: "openclaw:widget-size", height: 720 },
      });
    active = false;
    owner.activityChanged();
    owner.update();
    reportHeight();
    expect(reportContentHeight).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshFrame).not.toHaveBeenCalled();

    active = true;
    owner.activityChanged();
    owner.update();
    expect(root.querySelector("iframe")).toBe(frame);
    reportHeight();
    expect(reportContentHeight).toHaveBeenCalledExactlyOnceWith("clock", 720);
    await vi.advanceTimersByTimeAsync(999);
    expect(refreshFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshFrame).toHaveBeenCalledOnce();
    owner.disconnect();
    reportHeight();
    expect(reportContentHeight).toHaveBeenCalledOnce();
  });

  it("pauses while hidden and re-arms when the document becomes visible", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const refreshFrame = vi.fn(async () => undefined);
    const widget = {
      name: "clock",
      revision: 1,
      viewTicket: "ticket",
      viewTicketTtlMs: 30_000,
    } as BoardWidget;
    recordBoardWidgetTicketReceipt(widget);
    const lifecycle = createTicketRefreshLifecycle(widget, refreshFrame);

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshFrame).not.toHaveBeenCalled();

      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(999);
      expect(refreshFrame).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshFrame).toHaveBeenCalledOnce();
    } finally {
      lifecycle.disconnect();
    }
  });

  it("schedules from a delayed lifecycle's remaining ticket lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const refreshFrame = vi.fn(async () => undefined);
    const widget = {
      name: "clock",
      revision: 1,
      viewTicket: "ticket",
      viewTicketTtlMs: 30_000,
    } as BoardWidget;
    recordBoardWidgetTicketReceipt(widget);
    await vi.advanceTimersByTimeAsync(10_000);
    const lifecycle = createTicketRefreshLifecycle(widget, refreshFrame);

    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(refreshFrame).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshFrame).toHaveBeenCalledOnce();
    } finally {
      lifecycle.disconnect();
    }
  });
});
