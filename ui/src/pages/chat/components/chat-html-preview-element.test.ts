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

function mount(request = vi.fn().mockResolvedValue(metadata), html = source) {
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
  view.html = html;
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
  it.each([
    {
      name: "ordinary, Unicode, percent-encoded and empty fragments",
      body: '<a href="#section">One</a><a href="#雪">Snow</a><a href="#%E9%9B%AA">Encoded</a><a href="#">Top</a>',
      expected:
        '<a href="about:srcdoc#section">One</a><a href="about:srcdoc#雪">Snow</a><a href="about:srcdoc#%E9%9B%AA">Encoded</a><a href="about:srcdoc#">Top</a>',
    },
    {
      name: "attribute spelling and entities without rewriting surrounding bytes",
      body: "<A class='jump' HREF = '&#35;a&amp;&quot;b' title='stay'>Jump</A>\r\n",
      expected: "<A class='jump' href=\"about:srcdoc#a&amp;&quot;b\" title='stay'>Jump</A>\r\n",
    },
    {
      name: "a named anchor and image-map link",
      body: '<a name="section"></a><map name="report"><area href="#section" alt="Jump"></map>',
      expected:
        '<a name="section"></a><map name="report"><area href="about:srcdoc#section" alt="Jump"></map>',
    },
    {
      name: "authored base URL",
      head: '<base href="https://example.com/report">',
      body: '<a href="#section">Jump</a>',
    },
    {
      name: "independent base URL and target declarations",
      head: '<base target="_self"><base href="/report">',
      body: '<a href="#section">Jump</a>',
    },
    {
      name: "base target with explicit self and empty overrides",
      head: '<base target="_blank">',
      body: '<a href="#section">Other</a><a target="_self" href="#section">Here</a><a target="" href="#section">Empty</a>',
      expected:
        '<a href="#section">Other</a><a target="_self" href="about:srcdoc#section">Here</a><a target="" href="about:srcdoc#section">Empty</a>',
    },
    {
      name: "explicit targets, downloads and nonfragment URLs",
      body: '<a href="#section" target="report">Other</a><a download href="#section">Download</a><a href="report.html#section">File</a><a href="https://example.com/#section">Web</a>',
    },
    {
      name: "duplicate attributes",
      body: '<a href="#first" href="#second">Jump</a>',
      expected: '<a href="about:srcdoc#first" href="#second">Jump</a>',
    },
    {
      name: "unrelated duplicate attributes",
      body: '<p title="first" title="ignored">Report</p><a href="#section">Jump</a>',
      expected:
        '<p title="first" title="ignored">Report</p><a href="about:srcdoc#section">Jump</a>',
    },
    {
      name: "a complete link before an unfinished unrelated tail",
      body: '<a href="#section">Jump</a><p title="unfinished',
      expected: '<a href="about:srcdoc#section">Jump</a><p title="unfinished',
    },
    {
      name: "anchors reconstructed across paragraphs",
      body: '<p><a href="#x">one<p>two',
      expected: '<p><a href="about:srcdoc#x">one<p>two',
    },
    {
      name: "anchors reconstructed across formatting elements",
      body: '<b><a href="#x">one</b>two',
      expected: '<b><a href="about:srcdoc#x">one</b>two',
    },
    {
      name: "leading C0 controls and ASCII whitespace without treating NBSP as URL whitespace",
      body: '<a href="\u0001\u001f \t\n#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
      expected: '<a href="about:srcdoc#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
    },
    {
      name: "malformed attributes",
      body: '<a href=#section title="unfinished>Jump</a>',
    },
    {
      name: "inert template contents",
      body: '<template><base href="/report"><a href="#section">Later</a></template><a href="#section">Now</a>',
      expected:
        '<template><base href="/report"><a href="#section">Later</a></template><a href="about:srcdoc#section">Now</a>',
    },
    {
      name: "foreign-namespace anchors",
      body: '<svg><a href="#section"><text>Vector</text></a></svg><a href="#section">HTML</a>',
      expected:
        '<svg><a href="#section"><text>Vector</text></a></svg><a href="about:srcdoc#section">HTML</a>',
    },
    {
      name: "script, style and comment bytes",
      body: '<script>const sample = \'<a href="#section">\';</script><style>/* <a href="#section"> */</style><!-- <a href="#section"> --><a href="#section">Jump</a>',
      expected:
        '<script>const sample = \'<a href="#section">\';</script><style>/* <a href="#section"> */</style><!-- <a href="#section"> --><a href="about:srcdoc#section">Jump</a>',
    },
    {
      name: "documents with no links",
      body: "<p>雪 &amp; café</p>\r\n",
    },
  ])(
    "prepares $name only in sandbox display bytes",
    async ({ head = "", body, expected = body }) => {
      const prefix = `<!DOCTYPE html>\r\n<html><head><title>Report</title>${head}</head><body>`;
      const suffix = "</body></html>\r\n";
      const html = prefix + body + suffix;
      const request = vi.fn().mockResolvedValue({ ...metadata, html });
      const { view } = mount(request, html);
      const frame = await frameFor(view);
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      message(frame, ready(frame));
      await expect.poll(() => post.mock.calls.length).toBe(1);
      expect(post.mock.calls[0]![0].params.html).toBe(prefix + expected + suffix);
      expect(view.html).toBe(html);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "canvas.document.preview",
        { html },
        { timeoutMs: 10_000 },
      );
    },
  );

  it("prepares noscript using the replacement frame's mode without rereading source", async () => {
    const html = '<!doctype html><body><noscript><a href="#section">Jump</a></noscript></body>';
    const request = vi.fn().mockResolvedValue({ ...metadata, html });
    const { view } = mount(request, html);
    for (const mode of ["scripts", "strict", "trusted"] as const) {
      view.embedSandboxMode = mode;
      await view.updateComplete;
      const frame = await frameFor(view);
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      message(frame, ready(frame));
      await expect.poll(() => post.mock.calls.length).toBe(1);
      expect(post.mock.calls[0]![0].params).toEqual({
        html:
          mode === "strict" ? html.replace('href="#section"', 'href="about:srcdoc#section"') : html,
        renderId: expect.any(String),
        ...(mode === "strict" ? { allowScripts: false } : {}),
      });
    }
    expect(request).toHaveBeenCalledOnce();
    expect(view.html).toBe(html);
  });

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
