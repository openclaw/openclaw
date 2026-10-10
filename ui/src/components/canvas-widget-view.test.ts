/* @vitest-environment jsdom */
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  bumpCanvasWidgetFrameConnectionGeneration,
  getCanvasWidgetFrameConnectionGeneration,
} from "../lib/chat/canvas-widget-frame-generation.ts";
import { OpenClawCanvasWidgetView } from "./canvas-widget-view.ts";
import { WIDGET_PROMPT_EVENT } from "./mcp-app-security.ts";

const elementName = `test-canvas-widget-${crypto.randomUUID()}`;
customElements.define(elementName, class extends OpenClawCanvasWidgetView {});
const documentView: CanvasDocumentViewResult = {
  html: "<p>Widget ready</p>",
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};

type WidgetGatewaySnapshot = Omit<Partial<ApplicationGatewaySnapshot>, "client"> & {
  client: { request: ReturnType<typeof vi.fn> };
};

const gateways = new WeakMap<
  OpenClawCanvasWidgetView,
  {
    snapshot: WidgetGatewaySnapshot;
    connectionRevision: number;
    notify: () => void;
  }
>();

async function settle(view: OpenClawCanvasWidgetView) {
  for (let i = 0; i < 4; i += 1) {
    await view.updateComplete;
    await Promise.resolve();
  }
}

function connection(
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

function mount(
  client: { request: ReturnType<typeof vi.fn> },
  docId = "cv_inline",
  parent: Element | ShadowRoot = document.body,
) {
  const view = document.createElement(elementName) as OpenClawCanvasWidgetView;
  const gateway = {
    snapshot: { client, phase: "connected" } as WidgetGatewaySnapshot,
    connection: { gatewayUrl: "ws://gateway.example:8443" },
    connectionRevision: 0,
    notify: () => {},
    subscribe: (notify: () => void) => {
      gateway.notify = notify;
      return () => {};
    },
  };
  gateways.set(view, gateway);
  Reflect.set(view, "context", { gateway });
  view.docId = docId;
  view.sessionKey = "agent:main:widget-test";
  view.messageTimestamp = Date.now();
  view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
  parent.append(view);
  return view;
}

async function frameFor(view: OpenClawCanvasWidgetView) {
  await expect.poll(() => view.querySelector("iframe")).not.toBeNull();
  return view.querySelector("iframe")!;
}

function message(
  frame: HTMLIFrameElement,
  data: unknown,
  ports: MessagePort[] = [],
  origin?: string,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: origin ?? new URL(frame.src).origin,
      data,
      ports,
    }),
  );
}

describe("Canvas widget view", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads authenticated HTML once for concurrent views and waits for the exact isolated proxy", async () => {
    let resolve!: (value: CanvasDocumentViewResult) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise<CanvasDocumentViewResult>((done) => {
            resolve = done;
          }),
      ),
    };
    const first = mount(client);
    const second = mount(client);
    await expect.poll(() => client.request.mock.calls.length).toBe(1);
    expect(client.request).toHaveBeenCalledWith(
      "canvas.document.view",
      { docId: "cv_inline" },
      { timeoutMs: 30_000 },
    );
    resolve(documentView);
    const frame = await frameFor(first);
    await frameFor(second);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const ready = {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: frame.src },
    };
    message(frame, ready, [], "https://attacker.example");
    message(frame, { ...ready, params: { sandboxUrl: `${frame.src}&stale=1` } });
    expect(post).not.toHaveBeenCalled();
    message(frame, ready);
    await expect
      .poll(() =>
        post.mock.calls.some(([data]) => data.method === "ui/notifications/sandbox-resource-ready"),
      )
      .toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: documentView.html, renderId: expect.any(String) },
      }),
      "http://gateway.example:8444",
    );
    expect(first.documentHtml).toBe(documentView.html);
    message(frame, { type: "openclaw:widget-size", height: 3000 });
    await first.updateComplete;
    expect(frame.style.height).toBe("3000px");
    first.title = "Updated title";
    await first.updateComplete;
    expect(first.querySelector("iframe")).toBe(frame);
    expect(client.request).toHaveBeenCalledOnce();
    first.remove();
    client.request.mockResolvedValue(documentView);
    await frameFor(mount(client));
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it.each(["generation", "client"])(
    "discards an old connection's read when its %s changes",
    async (change) => {
      let resolveOld!: (value: CanvasDocumentViewResult) => void;
      const client = {
        request: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<CanvasDocumentViewResult>((done) => {
                resolveOld = done;
              }),
          )
          .mockResolvedValue({ ...documentView, html: "<p>New connection</p>" }),
      };
      const view = mount(client);
      await expect.poll(() => client.request.mock.calls.length).toBe(1);
      const replacement = {
        request: vi.fn().mockResolvedValue({ ...documentView, html: "<p>New connection</p>" }),
      };
      if (change === "generation") {
        bumpCanvasWidgetFrameConnectionGeneration();
        view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
      } else {
        gateways.get(view)!.snapshot.client = replacement;
        gateways.get(view)!.notify();
      }
      await frameFor(view);
      resolveOld(documentView);
      await settle(view);
      expect(view.documentHtml).toBe("<p>New connection</p>");
      expect(client.request).toHaveBeenCalledTimes(change === "generation" ? 2 : 1);
      expect(replacement.request).toHaveBeenCalledTimes(change === "client" ? 1 : 0);
    },
  );

  it("renders authenticated HTML inertly until scripts are enabled without rereading it", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client);
    view.allowScripts = false;
    const strictFrame = await frameFor(view);
    expect(strictFrame.getAttribute("src")).toBeNull();
    expect(strictFrame.srcdoc).toBe(documentView.html);
    expect(strictFrame.getAttribute("sandbox")).toBe("");
    view.allowScripts = true;
    await view.updateComplete;
    const interactiveFrame = await frameFor(view);
    expect(interactiveFrame).not.toBe(strictFrame);
    expect(interactiveFrame.src).toBe("http://gateway.example:8444/mcp-app-sandbox?frames=none");
    expect(interactiveFrame.hasAttribute("srcdoc")).toBe(false);
    interactiveFrame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.querySelector('[role="status"]')?.textContent).toContain("recover automatically");
    view.allowScripts = false;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.srcdoc).toBe(documentView.html);
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("shows a failed read and retries without keeping the rejected shared request", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("Widget unavailable"))
        .mockResolvedValue(documentView),
    };
    const view = mount(client);
    await expect
      .poll(() => view.querySelector('[role="alert"]')?.textContent)
      .toContain("Widget unavailable");
    view.querySelector("button")!.click();
    await frameFor(view);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("retains rendered content across client replacement, revalidates unchanged bytes, and replaces changed bytes", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client);
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    message(frame, {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: frame.src },
    });
    await settle(view);
    const replacement = { request: vi.fn().mockResolvedValue(documentView) };
    gateways.get(view)!.snapshot.client = replacement;
    connection(view, "reconnecting");
    await settle(view);
    expect(view.querySelector("iframe")).toBe(frame);
    expect(view.documentHtml).toBe(documentView.html);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(replacement.request).not.toHaveBeenCalled();
    connection(view, "connected");
    await settle(view);
    expect(client.request).toHaveBeenCalledOnce();
    expect(replacement.request).toHaveBeenCalledExactlyOnceWith(
      "canvas.document.view",
      { docId: view.docId },
      { timeoutMs: 30_000 },
    );
    expect(view.querySelector("iframe")).toBe(frame);
    expect(
      post.mock.calls.filter(([data]) => data.method === "ui/notifications/sandbox-resource-ready"),
    ).toHaveLength(1);
    replacement.request.mockResolvedValue({ ...documentView, html: "<p>Updated bytes</p>" });
    connection(view, "reconnecting");
    await settle(view);
    connection(view, "connected");
    await settle(view);
    expect(view.querySelector("iframe")).not.toBe(frame);
    expect(view.documentHtml).toBe("<p>Updated bytes</p>");
  });

  it("hands scroll intent to its transcript only from the current isolated widget", async () => {
    const thread = document.createElement("div");
    const sibling = document.createElement("div");
    thread.className = sibling.className = "chat-thread";
    document.body.append(thread, sibling);
    const events: Array<{ type: string; deltaY: number; scrollTop: number }> = [];
    thread.scrollTop = 400;
    thread.addEventListener("wheel", (event) => {
      events.push({ type: "wheel", deltaY: event.deltaY, scrollTop: thread.scrollTop });
    });
    Object.defineProperty(thread, "scrollBy", {
      value: vi.fn((options: ScrollToOptions) => {
        const deltaY = options.top ?? 0;
        events.push({ type: "scroll", deltaY, scrollTop: thread.scrollTop });
        thread.scrollTop += deltaY;
      }),
    });
    const scrollSibling = vi.fn();
    sibling.scrollBy = scrollSibling;
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, "cv_scroll", thread);
    const start = async (frame: HTMLIFrameElement) => {
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      message(frame, {
        method: "ui/notifications/sandbox-proxy-ready",
        params: { sandboxUrl: frame.src },
      });
      await settle(view);
      expect(post).toHaveBeenCalledWith(
        { type: "openclaw:widget-board-host", nonce: expect.any(String) },
        new URL(frame.src).origin,
      );
      const nonce = post.mock.calls.find(([data]) => data.type === "openclaw:widget-board-host")![0]
        .nonce;
      const renderId = post.mock.calls.find(
        ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
      )![0].params.renderId;
      post.mockClear();
      message(frame, {
        method: "ui/notifications/sandbox-resource-loaded",
        params: { renderId },
      });
      // Stored wrappers can miss host state until their document finishes loading.
      expect(post).toHaveBeenCalledWith(
        { type: "openclaw:widget-board-host", nonce },
        new URL(frame.src).origin,
      );
      return nonce;
    };
    const frame = await frameFor(view);
    const nonce = await start(frame);
    const scroll = { type: "openclaw:widget-scroll", nonce, deltaY: 120 };
    const foreignFrame = document.createElement("iframe");
    foreignFrame.src = frame.src;
    sibling.append(foreignFrame);
    message(frame, scroll, [], "https://wrong.example");
    message(foreignFrame, scroll);
    message(frame, { ...scroll, nonce: "wrong" });
    for (const deltaY of ["120", undefined, Infinity, Number.NaN]) {
      message(frame, { ...scroll, deltaY });
    }
    expect(events).toEqual([]);
    message(frame, scroll);
    expect(events).toEqual([
      { type: "wheel", deltaY: 120, scrollTop: 400 },
      { type: "scroll", deltaY: 120, scrollTop: 400 },
    ]);
    expect(thread.scrollTop).toBe(520);
    events.length = 0;

    const oldSource = frame.contentWindow;
    view.docId = "cv_scroll_replaced";
    message(frame, scroll);
    await settle(view);
    const current = await frameFor(view);
    expect(current).not.toBe(frame);
    const currentNonce = await start(current);
    expect(currentNonce).not.toBe(nonce);
    message(current, scroll);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: oldSource,
        origin: new URL(current.src).origin,
        data: { ...scroll, nonce: currentNonce },
      }),
    );
    expect(events).toEqual([]);
    message(current, { ...scroll, nonce: currentNonce, deltaY: -80 });
    expect(events).toEqual([
      { type: "wheel", deltaY: -80, scrollTop: 520 },
      { type: "scroll", deltaY: -80, scrollTop: 520 },
    ]);
    expect(thread.scrollTop).toBe(440);
    events.length = 0;
    view.remove();
    message(current, { ...scroll, nonce: currentNonce });
    expect(events).toEqual([]);
    expect(scrollSibling).not.toHaveBeenCalled();
    expect(sibling.scrollTop).toBe(0);
  });

  it.each(["credential", "session", "denied"])(
    "retires retained content after %s changes",
    async (change) => {
      const client = { request: vi.fn().mockResolvedValue(documentView) };
      const view = mount(client);
      const frame = await frameFor(view);
      connection(view, "reconnecting");
      await settle(view);
      client.request.mockRejectedValue(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access denied" }),
      );
      if (change === "credential") {
        gateways.get(view)!.connectionRevision += 1;
      }
      if (change === "session") {
        view.sessionKey = "agent:other:session";
      }
      if (change !== "denied") {
        gateways.get(view)!.notify();
        await settle(view);
        expect(view.querySelector("iframe")).toBeNull();
        expect(view.documentHtml).toBeUndefined();
      }
      connection(view, "connected");
      await settle(view);
      expect(view.querySelector("iframe")).toBeNull();
      expect(frame.isConnected).toBe(false);
      expect(view.documentHtml).toBeUndefined();
      expect(view.querySelector('[role="alert"]')?.textContent).toContain("Access denied");
    },
  );

  it("paces timed-out reads and stops retrying while offline", async () => {
    vi.useFakeTimers();
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "canvas.document.view",
      timeoutMs: 10_000,
      requestSent: true,
    });
    const client = { request: vi.fn().mockRejectedValue(timeout) };
    const view = mount(client);
    await settle(view);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.querySelector('[role="status"]')?.textContent).toContain("recover automatically");
    await vi.advanceTimersByTimeAsync(999);
    expect(client.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    connection(view, "reconnecting");
    await settle(view);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.request).toHaveBeenCalledTimes(2);
    client.request.mockResolvedValue(documentView);
    connection(view, "connected");
    await settle(view);
    expect(view.querySelector("iframe")).not.toBeNull();
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("keeps a slow authenticated read alive after the loading notice", async () => {
    vi.useFakeTimers();
    const client = {
      request: vi.fn(async () => {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 15_000);
        });
        return documentView;
      }),
    };
    const view = mount(client);
    view.preferredHeight = 520;
    await settle(view);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.querySelector('[role="status"]')?.textContent).toContain("recover automatically");
    expect(view.querySelector<HTMLElement>('[role="status"]')?.style.minHeight).toBe("520px");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(view);
    expect(client.request).toHaveBeenCalledOnce();
    expect(view.querySelector("iframe")).not.toBeNull();
  });

  it("retains a known profile through reconnect presence hydration but clears a verified mismatch", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client);
    gateways.get(view)!.snapshot.selfUser = {
      id: "owner",
    } as ApplicationGatewaySnapshot["selfUser"];
    const frame = await frameFor(view);
    connection(view, "reconnecting", { selfUser: null });
    await settle(view);
    connection(view, "connected", { selfUser: null });
    await settle(view);
    expect(view.querySelector("iframe")).toBe(frame);
    gateways.get(view)!.snapshot.selfUser = {
      id: "owner",
    } as ApplicationGatewaySnapshot["selfUser"];
    gateways.get(view)!.notify();
    await settle(view);
    expect(view.querySelector("iframe")).toBe(frame);
    gateways.get(view)!.snapshot.selfUser = {
      id: "other",
    } as ApplicationGatewaySnapshot["selfUser"];
    gateways.get(view)!.notify();
    await settle(view);
    expect(view.querySelector("iframe")).not.toBe(frame);
  });

  it("does not wake the agent for offline or resource-download errors", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, "cv_network_error");
    const frame = await frameFor(view);
    message(frame, { type: "openclaw:widget-runtime-error", message: "Failed to fetch" });
    connection(view, "reconnecting");
    message(frame, { type: "openclaw:widget-runtime-error", message: "d3 is not defined" });
    await settle(view);
    expect(client.request).toHaveBeenCalledOnce();
    expect(view.querySelector("iframe")).toBe(frame);
  });

  it("refuses a sandbox on the authenticated Gateway origin", async () => {
    const client = { request: vi.fn().mockResolvedValue({ ...documentView, sandboxPort: 8443 }) };
    const view = mount(client);
    await expect
      .poll(() => view.querySelector('[role="alert"]')?.textContent)
      .toContain("Sandbox host URL is invalid");
    expect(view.querySelector("iframe")).toBeNull();
  });

  it.each([
    {
      label: "short Unicode title",
      title: "Ready 😀",
      expectedTitle: "Ready 😀",
      message: "x".repeat(600),
      expectedMessage: "x".repeat(500),
    },
    {
      label: "ASCII title limit",
      title: "x".repeat(81),
      expectedTitle: "x".repeat(80),
      message: "x".repeat(600),
      expectedMessage: "x".repeat(500),
    },
    {
      label: "surrogate title boundary",
      title: `${"x".repeat(79)}😀tail`,
      expectedTitle: "x".repeat(79),
      message: "x".repeat(600),
      expectedMessage: "x".repeat(500),
    },
    {
      label: "short Unicode message",
      title: "Status",
      expectedTitle: "Status",
      message: "Ready 😀",
      expectedMessage: "Ready 😀",
    },
    {
      label: "surrogate message boundary",
      title: "Status",
      expectedTitle: "Status",
      message: `${"x".repeat(499)}😀tail`,
      expectedMessage: "x".repeat(499),
    },
    {
      label: "stored dangling surrogate",
      title: "Status",
      expectedTitle: "Status",
      message: `${"x".repeat(499)}\ud83d`,
      expectedMessage: `${"x".repeat(499)}\ufffd`,
    },
  ])(
    "shows a bounded script error and wakes only once with a $label",
    async ({ label, title, expectedTitle, message: errorMessage, expectedMessage }) => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const client = { request: vi.fn().mockResolvedValue(documentView) };
      const docId = `cv_runtime_error_${label}`;
      const view = mount(client, docId);
      view.messageTimestamp = now - 600_000;
      view.title = title;
      const frame = await frameFor(view);
      const report = {
        type: "openclaw:widget-runtime-error",
        message: errorMessage,
        source: "https://example.test/private/widget.js",
        line: 12,
        column: 7,
      };
      message(frame, report, [], "https://wrong.example");
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: new URL(frame.src).origin,
          data: report,
        }),
      );
      expect(client.request).toHaveBeenCalledOnce();
      message(frame, report);
      message(frame, report);
      message(frame, { ...report, message: "Another failure" });
      await view.updateComplete;
      expect(client.request).toHaveBeenCalledTimes(2);
      expect(client.request).toHaveBeenLastCalledWith("wake", {
        mode: "now",
        sessionKey: view.sessionKey,
        text: `Inline widget "${expectedTitle}" (${docId}) threw a script error after rendering: ${expectedMessage}, line 12, column 7. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`,
      });
      expect(view.querySelector('[role="status"]')?.textContent).toBe(
        `Script error: ${expectedMessage}`,
      );
      expect(view.querySelector("iframe")).toBe(frame);
      view.remove();
      const remount = await frameFor(mount(client, docId));
      message(remount, report);
      expect(client.request).toHaveBeenCalledTimes(3);
    },
  );

  it("ignores stale sessions and malformed errors and omits invalid locations", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, "cv_runtime_invalid");
    const frame = await frameFor(view);
    const report = { type: "openclaw:widget-runtime-error", message: "Missing element" };
    message(frame, { ...report, message: { message: "Invalid" } });
    view.sessionKey = "agent:main:changed";
    message(frame, report);
    expect(client.request).toHaveBeenCalledOnce();
    await view.updateComplete;
    const current = await frameFor(view);
    message(current, { ...report, line: Infinity, column: 1.5 });
    await view.updateComplete;
    expect(client.request).toHaveBeenLastCalledWith("wake", {
      mode: "now",
      sessionKey: view.sessionKey,
      text: 'Inline widget "" (cv_runtime_invalid) threw a script error after rendering: Missing element. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.',
    });
  });

  it.each([
    { label: "older than ten minutes", ageMs: 600_001 },
    { label: "missing", ageMs: undefined },
    { label: "non-finite", ageMs: Infinity },
  ])(
    "keeps the notice but gates wakes when the message timestamp is $label",
    async ({ label, ageMs }) => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const client = { request: vi.fn().mockResolvedValue(documentView) };
      const view = mount(client, `cv_runtime_age_${label}`);
      view.messageTimestamp = ageMs === undefined ? undefined : now - ageMs;
      const frame = await frameFor(view);
      message(frame, { type: "openclaw:widget-runtime-error", message: "Missing element" });
      await view.updateComplete;
      expect(view.querySelector('[role="status"]')?.textContent).toBe(
        "Script error: Missing element",
      );
      expect(client.request.mock.calls.filter(([method]) => method === "wake")).toHaveLength(0);
      expect(view.querySelector("iframe")).toBe(frame);
    },
  );

  it("refreshes theme tokens inside a shadow-root chat without reloading the document", async () => {
    // jsdom does not allocate browsing contexts for shadow-root iframes; Chromium covers them end to end.
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
    const container = document.createElement("div");
    document.body.append(container);
    const root = container.attachShadow({ mode: "open" });
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, "cv_theme", root);
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    document.documentElement.dataset.themeMode = "light";
    await expect
      .poll(() =>
        post.mock.calls.some(
          ([data]) => data.type === "openclaw:widget-theme" && data.mode === "light",
        ),
      )
      .toBe(true);
    expect(view.querySelector("iframe")).toBe(frame);
    expect(client.request).toHaveBeenCalledOnce();
    view.remove();
    post.mockClear();
    document.documentElement.dataset.themeMode = "dark";
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    "disconnect",
    "strict mode",
    "strict then scripts",
    "connection recovery",
    "client replacement",
    "parking",
  ])("gates the focused private prompt channel on %s", async (change) => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, `cv_prompt_${change}`);
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    message(frame, {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: frame.src },
    });
    await Promise.resolve();
    let onMessage!: (event: MessageEvent) => void;
    const postMessage = vi.fn();
    const close = vi.fn();
    const port = {
      addEventListener: vi.fn((_type, handler) => {
        onMessage = handler;
      }),
      start: vi.fn(),
      postMessage,
      close,
    } as unknown as MessagePort;
    const received = vi.fn();
    view.addEventListener(WIDGET_PROMPT_EVENT, received);
    message(frame, { type: "openclaw:widget-prompt-offer" }, [port]);
    expect(postMessage).toHaveBeenCalledWith({ type: "openclaw:widget-prompt-host-ready" });
    onMessage(
      new MessageEvent("message", {
        data: { type: "openclaw:widget-prompt", prompt: "Background" },
      }),
    );
    expect(received).not.toHaveBeenCalled();
    Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
    Object.defineProperty(frame, "checkVisibility", { value: () => true });
    message(frame, { type: "openclaw:widget-prompt", prompt: "Forged window message" });
    expect(received).not.toHaveBeenCalled();
    onMessage(
      new MessageEvent("message", {
        data: { type: "openclaw:widget-prompt", prompt: "Show details" },
      }),
    );
    expect(received).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledOnce();
    if (change === "parking") {
      const prompt = () =>
        onMessage(
          new MessageEvent("message", {
            data: { type: "openclaw:widget-prompt", prompt: "Resume details" },
          }),
        );
      const report = { type: "openclaw:widget-runtime-error", message: "Missing details" };
      view.presentationActive = false;
      prompt();
      message(frame, report);
      expect({
        prompts: received.mock.calls.length,
        requests: client.request.mock.calls.map(([method]) => method),
      }).toEqual({ prompts: 1, requests: ["canvas.document.view"] });
      message(frame, { type: "openclaw:widget-size", height: 520 });
      await settle(view);
      expect(view.querySelector("iframe")).toBe(frame);
      expect(frame.style.height).toBe("520px");
      expect(view.querySelector('[role="status"]')).toBeNull();
      expect(close).not.toHaveBeenCalled();
      view.presentationActive = true;
      await settle(view);
      prompt();
      expect(received).toHaveBeenCalledTimes(2);
      expect(client.request).toHaveBeenCalledOnce();
      expect(view.querySelector("iframe")).toBe(frame);
      expect(
        post.mock.calls.filter(
          ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
        ),
      ).toHaveLength(1);
      message(frame, report);
      expect(client.request).toHaveBeenLastCalledWith(
        "wake",
        expect.objectContaining({ sessionKey: view.sessionKey }),
      );
      return;
    }
    if (change === "connection recovery" || change === "client replacement") {
      connection(view, "reconnecting");
      await settle(view);
      const prompt = () =>
        onMessage(
          new MessageEvent("message", {
            data: { type: "openclaw:widget-prompt", prompt: "Resume details" },
          }),
        );
      prompt();
      expect(received).toHaveBeenCalledOnce();
      expect(view.querySelector("iframe")).toBe(frame);
      let revalidate!: (value: CanvasDocumentViewResult) => void;
      const currentClient =
        change === "client replacement"
          ? { request: vi.fn().mockResolvedValue(documentView) }
          : client;
      currentClient.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            revalidate = resolve;
          }),
      );
      gateways.get(view)!.snapshot.client = currentClient;
      connection(view, "connected");
      await settle(view);
      expect(currentClient.request).toHaveBeenLastCalledWith(
        "canvas.document.view",
        { docId: view.docId },
        { timeoutMs: 30_000 },
      );
      prompt();
      expect(received).toHaveBeenCalledOnce();
      expect(view.querySelector("iframe")).toBe(frame);
      revalidate(documentView);
      await settle(view);
      prompt();
      expect(received).toHaveBeenCalledTimes(2);
      expect(view.querySelector("iframe")).toBe(frame);
      expect(close).not.toHaveBeenCalled();
      if (change === "client replacement") {
        message(frame, { type: "openclaw:widget-runtime-error", message: "Missing details" });
        expect(currentClient.request).toHaveBeenLastCalledWith(
          "wake",
          expect.objectContaining({ sessionKey: view.sessionKey }),
        );
        expect(client.request).toHaveBeenCalledOnce();
      }
      return;
    }
    if (change === "disconnect") {
      view.remove();
    } else {
      view.allowScripts = false;
    }
    expect(close).toHaveBeenCalledOnce();
    onMessage(
      new MessageEvent("message", {
        data: { type: "openclaw:widget-prompt", prompt: "Stale port" },
      }),
    );
    expect(received).toHaveBeenCalledOnce();
    if (change === "strict then scripts") {
      view.allowScripts = true;
    }
    if (change !== "disconnect") {
      await view.updateComplete;
      const replacement = await frameFor(view);
      expect(replacement).not.toBe(frame);
      if (change === "strict mode") {
        expect(replacement.srcdoc).toBe(documentView.html);
        expect(replacement.getAttribute("sandbox")).toBe("");
      } else {
        expect(replacement.src).toBe(frame.src);
      }
      expect(client.request).toHaveBeenCalledOnce();
    }
  });
});
