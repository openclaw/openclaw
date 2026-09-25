/* @vitest-environment jsdom */
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function mount(
  client: { request: ReturnType<typeof vi.fn> },
  docId = "cv_inline",
  parent: Element | ShadowRoot = document.body,
) {
  const view = document.createElement(elementName) as OpenClawCanvasWidgetView;
  Reflect.set(view, "context", {
    gateway: {
      snapshot: { client },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
    },
  });
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
      { timeoutMs: 10_000 },
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

  it("discards an old connection's read even when the Gateway client object is reused", async () => {
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
    bumpCanvasWidgetFrameConnectionGeneration();
    view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
    await frameFor(view);
    resolveOld(documentView);
    await Promise.resolve();
    expect(view.documentHtml).toBe("<p>New connection</p>");
    expect(client.request).toHaveBeenCalledTimes(2);
  });

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
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
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

  it("refuses a sandbox on the authenticated Gateway origin", async () => {
    const client = { request: vi.fn().mockResolvedValue({ ...documentView, sandboxPort: 8443 }) };
    const view = mount(client);
    await expect
      .poll(() => view.querySelector('[role="alert"]')?.textContent)
      .toContain("Sandbox host URL is invalid");
    expect(view.querySelector("iframe")).toBeNull();
  });

  it("shows a bounded script error and wakes the session only once across document remounts", async () => {
    const client = { request: vi.fn().mockResolvedValue(documentView) };
    const view = mount(client, "cv_runtime_error");
    view.title = "Status".repeat(20);
    const frame = await frameFor(view);
    const report = {
      type: "openclaw:widget-runtime-error",
      message: "x".repeat(600),
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
      text: `Inline widget "${view.title.slice(0, 80)}" (cv_runtime_error) threw a script error after rendering: ${"x".repeat(500)}, line 12, column 7. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`,
    });
    expect(view.querySelector('[role="status"]')?.textContent).toBe(
      `Script error: ${"x".repeat(500)}`,
    );
    expect(view.querySelector("iframe")).toBe(frame);
    view.remove();
    const remount = await frameFor(mount(client, "cv_runtime_error"));
    message(remount, report);
    expect(client.request).toHaveBeenCalledTimes(3);
  });

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
    { label: "exactly ten minutes old", ageMs: 600_000, wakes: true },
    { label: "older than ten minutes", ageMs: 600_001, wakes: false },
    { label: "missing", ageMs: undefined, wakes: false },
    { label: "non-finite", ageMs: Infinity, wakes: false },
    { label: "NaN", ageMs: Number.NaN, wakes: false },
  ])(
    "keeps the notice but gates wakes when the message timestamp is $label",
    async ({ label, ageMs, wakes }) => {
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
      expect(client.request.mock.calls.filter(([method]) => method === "wake")).toHaveLength(
        wakes ? 1 : 0,
      );
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

  it.each(["disconnect", "strict mode", "strict then scripts"])(
    "retires the focused private prompt port on %s",
    async (change) => {
      const client = { request: vi.fn().mockResolvedValue(documentView) };
      const view = mount(client);
      const frame = await frameFor(view);
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
    },
  );
});
