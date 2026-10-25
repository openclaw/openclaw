import type {
  CanvasDocumentViewResult,
  SessionsFilesAssetsResult,
} from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatHtmlPreviewElement } from "./chat-html-preview-element.tsx";
/* @vitest-environment jsdom */
import "./chat-html-preview-element.tsx";

const source =
  "<!doctype html>\r\n<style>h1{color:red}</style><h1>HTML</h1><script>window.ready=true</script>\n";
const metadata: CanvasDocumentViewResult = {
  html: source,
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};

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
  // SAFETY: This transport fixture only consumes the Gateway portion of application context.
  const wrapper = createApplicationContextProvider(context as unknown as ApplicationContext);
  const view = document.createElement("openclaw-chat-html-preview");
  view.html = html;
  view.sourceIdentity = "file:example.html";
  wrapper.append(view);
  document.body.append(wrapper);
  return {
    view,
    context,
    request,
    setContext: (next: ApplicationContext) => wrapper.setContext(next),
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

async function frameFor(view: ChatHtmlPreviewElement) {
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

async function transferFrom(
  frame: HTMLIFrameElement,
  post = vi.spyOn(frame.contentWindow!, "postMessage"),
) {
  message(frame, ready(frame));
  await expect.poll(() => post.mock.calls.length).toBe(1);
  return post.mock.calls[0]!;
}

const assetStatus = (view: ChatHtmlPreviewElement) =>
  view.querySelector('.file-view__save-notice[role="status"]');
const alert = (view: ChatHtmlPreviewElement) => view.querySelector('[role="alert"]');

const linkCase = (name: string, body: string, expected = body, head = "") => ({
  name,
  body,
  expected,
  head,
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ordinary HTML preview transport", () => {
  it.each([
    linkCase(
      "ordinary, Unicode, percent-encoded and empty fragments",
      '<a href="#section">One</a><a href="#雪">Snow</a><a href="#%E9%9B%AA">Encoded</a><a href="#">Top</a>',
      '<a href="about:srcdoc#section">One</a><a href="about:srcdoc#雪">Snow</a><a href="about:srcdoc#%E9%9B%AA">Encoded</a><a href="about:srcdoc#">Top</a>',
    ),
    linkCase(
      "attribute spelling and entities without rewriting surrounding bytes",
      "<A class='jump' HREF = '&#35;a&amp;&quot;b' title='stay'>Jump</A>\r\n",
      "<A class='jump' href=\"about:srcdoc#a&amp;&quot;b\" title='stay'>Jump</A>\r\n",
    ),
    linkCase(
      "a named anchor and image-map link",
      '<a name="section"></a><map name="report"><area href="#section" alt="Jump"></map>',
      '<a name="section"></a><map name="report"><area href="about:srcdoc#section" alt="Jump"></map>',
    ),
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
    linkCase(
      "explicit targets, downloads and nonfragment URLs",
      '<a href="#section" target="report">Other</a><a download href="#section">Download</a><a href="report.html#section">File</a><a href="https://example.com/#section">Web</a>',
    ),
    linkCase(
      "duplicate attributes",
      '<a href="#first" href="#second">Jump</a>',
      '<a href="about:srcdoc#first" href="#second">Jump</a>',
    ),
    linkCase(
      "a complete link before an unfinished unrelated tail",
      '<a href="#section">Jump</a><p title="unfinished',
      '<a href="about:srcdoc#section">Jump</a><p title="unfinished',
    ),
    linkCase(
      "anchors reconstructed across formatting elements",
      '<b><a href="#x">one</b>two',
      '<b><a href="about:srcdoc#x">one</b>two',
    ),
    linkCase(
      "leading C0 controls and ASCII whitespace without treating NBSP as URL whitespace",
      '<a href="\u0001\u001f \t\n#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
      '<a href="about:srcdoc#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
    ),
    linkCase("malformed attributes", '<a href=#section title="unfinished>Jump</a>'),
    linkCase(
      "inert template contents",
      '<template><base href="/report"><a href="#section">Later</a></template><a href="#section">Now</a>',
      '<template><base href="/report"><a href="#section">Later</a></template><a href="about:srcdoc#section">Now</a>',
    ),
    linkCase(
      "foreign-namespace anchors",
      '<svg><a href="#section"><text>Vector</text></a></svg><a href="#section">HTML</a>',
      '<svg><a href="#section"><text>Vector</text></a></svg><a href="about:srcdoc#section">HTML</a>',
    ),
    linkCase(
      "script, style and comment bytes",
      '<script>const sample = \'<a href="#section">\';</script><style>/* <a href="#section"> */</style><!-- <a href="#section"> --><a href="#section">Jump</a>',
      '<script>const sample = \'<a href="#section">\';</script><style>/* <a href="#section"> */</style><!-- <a href="#section"> --><a href="about:srcdoc#section">Jump</a>',
    ),
    linkCase("documents with no links", "<p>雪 &amp; café</p>\r\n"),
  ])(
    "prepares $name only in sandbox display bytes",
    async ({ head = "", body, expected = body }) => {
      const prefix = `<!DOCTYPE html>\r\n<html><head><title>Report</title>${head}</head><body>`;
      const suffix = "</body></html>\r\n";
      const html = prefix + body + suffix;
      const request = vi.fn().mockResolvedValue({ ...metadata, html });
      const { view } = mount(request, html);
      const frame = await frameFor(view);
      const [transfer] = await transferFrom(frame);
      expect(transfer.params.html).toBe(prefix + expected + suffix);
      expect(view.html).toBe(html);
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
      const [transfer] = await transferFrom(frame);
      expect(transfer.params).toEqual({
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
      { timeoutMs: 30_000 },
    );
    expect(frame.src).toBe("http://gateway.example:8444/mcp-app-sandbox?frames=none");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(view.querySelector("h1, script")).toBeNull();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    message(frame, ready(frame), { origin: "https://wrong.example" });
    message(frame, ready(frame), { source: window });
    message(frame, { ...ready(frame), params: { sandboxUrl: frame.src + "&old=1" } });
    expect(post).not.toHaveBeenCalled();
    const [transfer, origin] = await transferFrom(frame, post);
    expect(transfer).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: source, renderId: expect.any(String) },
    });
    expect(origin).toBe("http://gateway.example:8444");
    message(frame, {
      method: "ui/notifications/sandbox-resource-loaded",
      params: { renderId: transfer.params.renderId },
    });
    await view.updateComplete;
    expect(view.querySelector('[role="status"]')).toBeNull();
    view.title = "Changed title";
    await view.updateComplete;
    expect(view.querySelector("iframe")).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
  });

  it("loads assets from the owning session and announces omissions beside the sandbox", async () => {
    const html = '<img src="a.png"><img src="missing.png"><a href="#section">Jump</a>';
    const canvas = Promise.resolve({ ...metadata, html });
    const assets: SessionsFilesAssetsResult = {
      assets: [
        { ref: "a.png", mimeType: "image/png", content: "YQ==" },
        { ref: "missing.png", error: "outside_session_boundary" },
      ],
    };
    const request = vi.fn((method: string) =>
      method === "canvas.document.preview" ? canvas : Promise.resolve(assets),
    );
    const { view } = mount(request, html);
    view.sessionFileSource = {
      sessionKey: "agent:sender:main",
      agentId: "sender",
      path: "/sender/report/index.html",
    };
    await view.updateComplete;
    await canvas;
    await view.updateComplete;
    const frame = view.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    const [transfer] = await transferFrom(frame);
    expect(transfer).toMatchObject({
      params: {
        html: '<img src="data:image/png;base64,YQ=="><img src="missing.png"><a href="about:srcdoc#section">Jump</a>',
      },
    });
    await view.updateComplete;
    expect(request).toHaveBeenCalledWith("sessions.files.assets", {
      sessionKey: "agent:sender:main",
      agentId: "sender",
      path: "/sender/report/index.html",
      refs: ["a.png", "missing.png"],
    });
    expect(assetStatus(view)?.textContent).toContain("Some assets couldn't be loaded (1)");
    expect(view.html).toBe(html);
  });

  it("retires an asset response when the same document moves to another owner", async () => {
    const html = '<img src="a.png">';
    const oldAssets = Promise.withResolvers<SessionsFilesAssetsResult>();
    const oldRequested = Promise.withResolvers<void>();
    const newRequested = Promise.withResolvers<void>();
    const request = vi.fn((method: string, params: { sessionKey?: string }) => {
      if (method === "canvas.document.preview") {
        return Promise.resolve({ ...metadata, html });
      }
      if (params.sessionKey === "agent:old:main") {
        oldRequested.resolve();
        return oldAssets.promise;
      }
      newRequested.resolve();
      return Promise.resolve({
        assets: [{ ref: "a.png", mimeType: "image/png", content: "Yg==" }],
      });
    });
    const { view } = mount(request, html);
    view.sessionFileSource = { sessionKey: "agent:old:main", path: "/report/index.html" };
    await oldRequested.promise;
    const oldFrame = view.querySelector("iframe")!;
    const oldPost = vi.spyOn(oldFrame.contentWindow!, "postMessage");
    message(oldFrame, ready(oldFrame));
    view.sessionFileSource = { sessionKey: "agent:new:main", path: "/report/index.html" };
    await newRequested.promise;
    const newFrame = view.querySelector("iframe")!;
    const transfer = transferFrom(newFrame);
    oldAssets.resolve({ assets: [{ ref: "a.png", error: "not_found" }] });
    expect((await transfer)[0]).toMatchObject({
      params: { html: '<img src="data:image/png;base64,Yg==">' },
    });
    await view.updateComplete;
    expect(oldPost).not.toHaveBeenCalled();
    expect(assetStatus(view)).toBeNull();
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
    const [transfer] = await transferFrom(strict);
    expect(transfer.params).toEqual({
      html: source,
      renderId: expect.any(String),
      allowScripts: false,
    });
    frame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(view.querySelector("iframe")).toBe(strict);
    expect(alert(view)).toBeNull();
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
      await waitForSolid(() =>
        expect(alert(view)?.textContent).toContain("Sandbox host URL is invalid"),
      );
      expect(view.querySelector("iframe")).toBeNull();
    },
  );

  it.each(["html", "identity", "context", "client", "generation", "disconnect"])(
    "rejects an old request after %s changes",
    async (change) => {
      const pending = Promise.withResolvers<CanvasDocumentViewResult>();
      const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(metadata);
      const { view, context, notify, setContext } = mount(request);
      await expect.poll(() => request.mock.calls.length).toBe(1);
      if (change === "html") {
        view.html = "<p>new</p>";
      }
      if (change === "identity") {
        view.sourceIdentity = "next.html";
      }
      if (change === "context") {
        setContext({ gateway: { ...context.gateway } } as unknown as ApplicationContext);
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
      pending.resolve({ ...metadata, html: "<p>STALE</p>" });
      await view.updateComplete;
      await Promise.resolve();
      if (change === "disconnect") {
        expect(view.querySelector("iframe")).toBeNull();
      } else {
        const frame = await frameFor(view);
        const [transfer] = await transferFrom(frame);
        expect(transfer.params.html).toBe(source);
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

  it("keeps failures terminal until retry or a replacement frame mode", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Preview denied"))
      .mockResolvedValue(metadata);
    const { view } = mount(request);
    await waitForSolid(() => expect(alert(view)?.textContent).toContain("Preview denied"));
    view.title += " ";
    await view.updateComplete;
    expect(request).toHaveBeenCalledOnce();
    view.querySelector("button")!.click();
    const frame = await frameFor(view);
    frame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(alert(view)).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    view.title += " ";
    await view.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    view.embedSandboxMode = "strict";
    const replacement = await frameFor(view);
    expect(replacement).not.toBe(frame);
    expect(alert(view)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    replacement.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(alert(view)).not.toBeNull();
    view.querySelector("button")!.click();
    await frameFor(view);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
