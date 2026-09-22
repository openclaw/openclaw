/* @vitest-environment jsdom */
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { ChatHtmlPreview } from "./chat-html-preview-element.ts";

const source =
  "<!doctype html>\r\n<style>h1{color:red}</style><h1>HTML</h1><script>window.ready=true</script>\n";
const metadata: CanvasDocumentViewResult = {
  html: source,
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};
const tag = `test-html-preview-${crypto.randomUUID()}`;
customElements.define(tag, class extends ChatHtmlPreview {});

function mount(request = vi.fn().mockResolvedValue(metadata)) {
  const listeners = new Set<() => void>();
  const context = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const view = document.createElement(tag) as ChatHtmlPreview;
  Reflect.set(view, "context", context);
  view.html = source;
  view.sourceIdentity = "file:example.html";
  document.body.append(view);
  return {
    view,
    context,
    request,
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

async function frameFor(view: ChatHtmlPreview) {
  await expect.poll(() => view.querySelector("iframe")).not.toBeNull();
  return view.querySelector("iframe")!;
}

function message(
  frame: HTMLIFrameElement,
  data: unknown,
  options: { source?: Window; origin?: string; ports?: MessagePort[] } = {},
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: options.source ?? frame.contentWindow,
      origin: options.origin ?? new URL(frame.src).origin,
      data,
      ports: options.ports ?? [],
    }),
  );
}

function ready(frame: HTMLIFrameElement) {
  return { method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ordinary HTML preview transport", () => {
  it("uses only the transient preview RPC and transfers exact source after an exact handshake", async () => {
    const { view, request } = mount();
    const frame = await frameFor(view);
    expect(request).toHaveBeenCalledWith(
      "canvas.document.preview",
      { html: source },
      { timeoutMs: 10_000 },
    );
    expect(frame.src).toBe("http://gateway.example:8444/mcp-app-sandbox?frames=none");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(view.querySelector("h1, style, script")).toBeNull();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    message(frame, ready(frame), { origin: "https://wrong.example" });
    message(frame, ready(frame), { source: window });
    message(frame, { ...ready(frame), params: { sandboxUrl: frame.src + "&old=1" } });
    expect(post).not.toHaveBeenCalled();
    message(frame, ready(frame));
    await expect.poll(() => post.mock.calls.length).toBe(1);
    const transfer = post.mock.calls[0]![0];
    expect(transfer).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: source, renderId: expect.any(String) },
    });
    expect(post.mock.calls[0]![1]).toBe("http://gateway.example:8444");
    message(frame, {
      method: "ui/notifications/sandbox-resource-loaded",
      params: { renderId: transfer.params.renderId },
    });
    await view.updateComplete;
    expect(view.querySelector('[role="status"]')).toBeNull();
    view.title = "Changed title";
    view.requestUpdate();
    await view.updateComplete;
    expect(view.querySelector("iframe")).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
  });

  it("closes unsupported ports without lending prompt, wake, tools, board or theme APIs", async () => {
    const { view, request } = mount();
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const close = vi.fn();
    const port = { close, postMessage: vi.fn(), start: vi.fn() } as unknown as MessagePort;
    message(frame, { type: "openclaw:widget-prompt-offer" }, { ports: [port] });
    message(frame, { type: "openclaw:widget-bridge-port-offer" }, { ports: [port] });
    message(frame, { type: "openclaw:widget-runtime-error", message: "Script failed" });
    message(frame, { type: "openclaw:widget-bridge-ready" });
    message(frame, { type: "openclaw:widget-prompt", prompt: "Run tools" });
    expect(close).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    message(
      frame,
      { type: "openclaw:widget-prompt-offer" },
      { source: sibling.contentWindow!, ports: [port] },
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("revokes transport before strict replacement and never trusts the app origin", async () => {
    const { view, request } = mount();
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    view.embedSandboxMode = "strict";
    message(frame, ready(frame));
    expect(post).not.toHaveBeenCalled();
    await view.updateComplete;
    const strict = await frameFor(view);
    expect(strict).not.toBe(frame);
    expect(strict.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(strict.hasAttribute("srcdoc")).toBe(false);
    expect(strict.src).toBe(frame.src);
    const strictPost = vi.spyOn(strict.contentWindow!, "postMessage");
    message(strict, ready(strict));
    await expect.poll(() => strictPost.mock.calls.length).toBe(1);
    expect(strictPost.mock.calls[0]![0].params).toEqual({
      html: source,
      renderId: expect.any(String),
      allowScripts: false,
    });
    frame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(view.querySelector("iframe")).toBe(strict);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    view.embedSandboxMode = "trusted";
    await view.updateComplete;
    const trusted = await frameFor(view);
    expect(trusted.src).toBe(frame.src);
    expect(trusted.hasAttribute("srcdoc")).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([8443, Number.NaN])(
    "rejects invalid or Gateway-origin sandbox metadata (%s)",
    async (sandboxPort) => {
      const { view } = mount(vi.fn().mockResolvedValue({ ...metadata, sandboxPort }));
      await expect
        .poll(() => view.querySelector('[role="alert"]')?.textContent)
        .toContain("Sandbox host URL is invalid");
      expect(view.querySelector("iframe")).toBeNull();
    },
  );

  it.each(["html", "identity", "context", "client", "generation", "disconnect"])(
    "rejects an old request after %s changes",
    async (change) => {
      let resolve!: (value: CanvasDocumentViewResult) => void;
      const request = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<CanvasDocumentViewResult>((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue(metadata);
      const { view, context, notify } = mount(request);
      await expect.poll(() => request.mock.calls.length).toBe(1);
      if (change === "html") {
        view.html = "<p>new</p>";
      }
      if (change === "identity") {
        view.sourceIdentity = "next.html";
      }
      if (change === "context") {
        Reflect.set(view, "context", { gateway: { ...context.gateway } });
      }
      if (change === "client") {
        context.gateway.snapshot.client = { request: vi.fn().mockResolvedValue(metadata) };
        notify();
      }
      if (change === "generation") {
        bumpCanvasWidgetFrameConnectionGeneration();
        notify();
      }
      if (change === "disconnect") {
        context.gateway.snapshot.phase = "offline";
        notify();
      }
      resolve({ ...metadata, html: "<p>STALE</p>" });
      await view.updateComplete;
      await Promise.resolve();
      if (change === "disconnect") {
        expect(view.querySelector("iframe")).toBeNull();
      } else {
        const frame = await frameFor(view);
        const post = vi.spyOn(frame.contentWindow!, "postMessage");
        message(frame, ready(frame));
        await expect.poll(() => post.mock.calls.length).toBe(1);
        expect(post.mock.calls[0]![0].params.html).toBe(source);
      }
    },
  );

  it("ignores a retired connection's already mounted frame before its replacement renders", async () => {
    const { view, notify } = mount();
    const frame = await frameFor(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    bumpCanvasWidgetFrameConnectionGeneration();
    message(frame, ready(frame));
    expect(post).not.toHaveBeenCalled();
    notify();
    await view.updateComplete;
    expect(await frameFor(view)).not.toBe(frame);
  });

  it("keeps read and transport failures terminal until an explicit retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Preview denied"))
      .mockResolvedValue(metadata);
    const { view } = mount(request);
    await expect
      .poll(() => view.querySelector('[role="alert"]')?.textContent)
      .toContain("Preview denied");
    view.requestUpdate();
    await view.updateComplete;
    expect(request).toHaveBeenCalledOnce();
    view.querySelector("button")!.click();
    const frame = await frameFor(view);
    frame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    view.requestUpdate();
    await view.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    view.querySelector("button")!.click();
    await frameFor(view);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
