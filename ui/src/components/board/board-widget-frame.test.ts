/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { BoardWidget } from "../../lib/board/types.ts";
import { recordBoardWidgetTicketReceipt } from "../../lib/board/widget-ticket-lifetime.ts";
import { WIDGET_PROMPT_EVENT } from "../mcp-app-security.ts";
import { boardWidget, gatewayContext } from "./board-view.test-support.ts";
import { BoardWidgetFrameLifecycle } from "./board-widget-frame.ts";

type LifecycleInternals = {
  boardHostNonce: string;
  sandboxOrigin: string;
  sandboxHost: {
    dispose: () => void;
    frame?: HTMLIFrameElement;
    handleMessage: (event: MessageEvent) => void;
    setActive: (active: boolean) => void;
    update?: (options: unknown) => void;
  } | null;
  frameFailureKey: string;
  frameRefreshAttempts: number;
  refreshFailedFrame: (widget: BoardWidget) => void;
};

function createTicketRefreshLifecycle(
  widget: BoardWidget,
  refreshFrame: (name: string) => Promise<void>,
): BoardWidgetFrameLifecycle {
  const lifecycle = new BoardWidgetFrameLifecycle({
    active: () => true,
    connected: () => true,
    context: () => undefined,
    refreshFrame: () => refreshFrame,
    reportContentHeight: () => {},
    scrollBy: () => {},
    requestUpdate: () => {},
    resolveFrameUrl: () => () => "",
    root: () => document,
    widget: () => widget,
  });
  lifecycle.connect();
  lifecycle.update();
  return lifecycle;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Drives the private terminal-failure path directly: attempts are exhausted so
// refreshFailedFrame surfaces the terminal message for the given sandbox origin.
function terminalFailureError(params: {
  widget: Partial<BoardWidget>;
  resolvedSandboxOrigin: string;
}): string {
  const widget = { name: "clock", revision: 1, ...params.widget } as BoardWidget;
  const lifecycle = new BoardWidgetFrameLifecycle({
    active: () => true,
    connected: () => true,
    context: () => undefined,
    refreshFrame: () => undefined,
    reportContentHeight: () => {},
    scrollBy: () => {},
    requestUpdate: () => {},
    resolveFrameUrl: () => () => "",
    root: () => document,
    widget: () => widget,
  });
  const internals = lifecycle as unknown as LifecycleInternals;
  internals.sandboxOrigin = params.resolvedSandboxOrigin;
  internals.frameFailureKey = `${widget.name}:${widget.revision}`;
  internals.frameRefreshAttempts = 3;
  internals.refreshFailedFrame(widget);
  return lifecycle.error;
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

  it("keeps the authorization message when no sandbox origin was resolved", () => {
    const message = terminalFailureError({ widget: {}, resolvedSandboxOrigin: "" });
    expect(message).toContain("authorization failed");
    expect(message).not.toContain("mcp.apps.sandboxOrigin");
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
      const lifecycle = new BoardWidgetFrameLifecycle({
        active: () => active,
        connected: () => true,
        context: () => context,
        refreshFrame: () => undefined,
        reportContentHeight: () => {},
        scrollBy,
        requestUpdate: () => {},
        resolveFrameUrl: () => () => "/__openclaw__/board/long-dashboard?bt=ticket",
        root: () => container,
        widget: () => widget,
      });
      lifecycle.connect();
      render(lifecycle.render(widget), container);
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
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            origin: "https://sandbox.example",
            data,
          }),
        );
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

  it("accepts a finite vertical remainder only from its exact iframe and nonce", () => {
    const widget = { name: "long-dashboard", revision: 1 } as BoardWidget;
    const scrollBy = vi.fn();
    const lifecycle = new BoardWidgetFrameLifecycle({
      active: () => true,
      connected: () => true,
      context: () => undefined,
      refreshFrame: () => undefined,
      reportContentHeight: () => {},
      scrollBy,
      requestUpdate: () => {},
      resolveFrameUrl: () => () => "",
      root: () => document,
      widget: () => widget,
    });
    const frame = document.createElement("iframe");
    frame.className = "board-widget__frame";
    document.body.append(frame);
    lifecycle.connect();
    (lifecycle as unknown as LifecycleInternals).boardHostNonce = "board-scroll-nonce";

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-scroll", deltaY: 48, nonce: "board-scroll-nonce" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "openclaw:widget-scroll", deltaY: 96, nonce: "board-scroll-nonce" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          type: "openclaw:widget-scroll",
          deltaY: Number.POSITIVE_INFINITY,
          nonce: "board-scroll-nonce",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-scroll", deltaY: 192, nonce: "wrong-nonce" },
      }),
    );

    expect(scrollBy).toHaveBeenCalledOnce();
    expect(scrollBy).toHaveBeenCalledWith(48);
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
    let confirmationRendered: ReturnType<typeof createDeferred<void>> | undefined;
    let active = true;
    const lifecycle = new BoardWidgetFrameLifecycle({
      active: () => active,
      connected: () => root.isConnected,
      context: () => context,
      refreshFrame: () => undefined,
      reportContentHeight: () => {},
      scrollBy: () => {},
      requestUpdate: () => {
        render(lifecycle.render(widget), root);
        if (root.querySelector('[role="alertdialog"]')) {
          confirmationRendered?.resolve();
        }
      },
      resolveFrameUrl: () => () => "/__openclaw__/board/confirm-parts?bt=ticket",
      root: () => root,
      widget: () => widget,
    });
    lifecycle.connect();
    render(lifecycle.render(widget), root);
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
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "https://sandbox.example",
          data,
          ports,
        }),
      );
    const channel = new MessageChannel();
    const initialized = createDeferred();
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
      confirmationRendered = createDeferred();
      const cancelled = send("cancelled", "Compare these parts");
      await Promise.race([confirmationRendered.promise, cancelled]);
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

      confirmationRendered = createDeferred();
      const accepted = send("accepted", "Order the selected parts");
      await Promise.race([confirmationRendered.promise, accepted]);
      [...root.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((button) => button.textContent?.trim() === "Send")!
        .click();
      await expect(accepted).resolves.toMatchObject({ ok: true, result: { ok: true } });
      expect(received).toEqual([{ text: "Order the selected parts" }]);
      expect(request).toHaveBeenCalledWith("board.prompt.authorize", { ticket: "ticket" });
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(root.querySelector('[role="alertdialog"]')).toBeNull();

      confirmationRendered = createDeferred();
      const suspended = send("suspended", "This request loses its active widget");
      await Promise.race([confirmationRendered.promise, suspended]);
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
  it("suspends frame work while inactive and reconnects on activation", async () => {
    vi.useFakeTimers();
    let active = true;
    const refreshFrame = vi.fn(async () => undefined);
    const widget = {
      name: "clock",
      revision: 1,
      viewTicket: "ticket",
      viewTicketTtlMs: 30_000,
    } as BoardWidget;
    recordBoardWidgetTicketReceipt(widget);
    const lifecycle = new BoardWidgetFrameLifecycle({
      active: () => active,
      connected: () => true,
      context: () => undefined,
      refreshFrame: () => refreshFrame,
      reportContentHeight: () => {},
      scrollBy: () => {},
      requestUpdate: () => {},
      resolveFrameUrl: () => () => "",
      root: () => document,
      widget: () => widget,
    });
    const frame = document.createElement("iframe");
    frame.className = "board-widget__frame";
    document.body.append(frame);
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const dispose = vi.fn();
    const handleMessage = vi.fn();
    const setActive = vi.fn();
    const internals = lifecycle as unknown as LifecycleInternals;

    lifecycle.connect();
    lifecycle.update();
    internals.sandboxOrigin = "https://sandbox.example";
    internals.sandboxHost = { dispose, handleMessage, setActive };
    active = false;
    lifecycle.activityChanged();
    lifecycle.update();

    expect(dispose).not.toHaveBeenCalled();
    expect(setActive).toHaveBeenCalledWith(false);
    expect(removeWindowListener).not.toHaveBeenCalledWith("message", expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: { method: "ui/notifications/sandbox-proxy-ready" },
      }),
    );
    expect(handleMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshFrame).not.toHaveBeenCalled();

    active = true;
    lifecycle.activityChanged();
    expect(setActive).toHaveBeenLastCalledWith(true);
    internals.sandboxHost = null;
    lifecycle.update();
    await vi.advanceTimersByTimeAsync(999);
    expect(refreshFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshFrame).toHaveBeenCalledOnce();
    internals.sandboxHost = { dispose, handleMessage, setActive };
    lifecycle.disconnect();
    expect(removeWindowListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(dispose).toHaveBeenCalledOnce();
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
