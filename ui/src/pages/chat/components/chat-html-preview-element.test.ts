/* @vitest-environment jsdom */
import { ContextProvider } from "@lit/context";
import type {
  CanvasDocumentViewResult,
  SessionsFilesAssetsResult,
} from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import type { ChatHtmlPreviewElement } from "./chat-html-preview-element.tsx";
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
  const wrapper = document.createElement("div");
  const provider = new ContextProvider(wrapper, {
    context: applicationContext,
    initialValue: context as unknown as ApplicationContext,
  });
  const view = document.createElement("openclaw-chat-html-preview");
  view.html = html;
  view.sourceIdentity = "file:example.html";
  wrapper.append(view);
  document.body.append(wrapper);
  return {
    view,
    context,
    request,
    setContext: (next: ApplicationContext) => provider.setValue(next),
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

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ordinary HTML preview transport", () => {
  it.each([
    {
      name: "a named anchor and image-map link",
      body: '<a name="section"></a><map name="report"><area href="#section" alt="Jump"></map>',
      expected:
        '<a name="section"></a><map name="report"><area href="about:srcdoc#section" alt="Jump"></map>',
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
      name: "leading C0 controls and ASCII whitespace without treating NBSP as URL whitespace",
      body: '<a href="\u0001\u001f \t\n#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
      expected: '<a href="about:srcdoc#section">Jump</a><a href="\u00a0#section">Relative URL</a>',
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
        { timeoutMs: 30_000 },
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
      { timeoutMs: 30_000 },
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
    const transfer = Promise.withResolvers<unknown>();
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((value: unknown) =>
      transfer.resolve(value),
    );
    message(frame, ready(frame));
    expect(await transfer.promise).toMatchObject({
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
    expect(view.querySelector('.file-view__save-notice[role="status"]')?.textContent).toContain(
      "Some assets couldn't be loaded (1)",
    );
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
    const transfer = Promise.withResolvers<unknown>();
    vi.spyOn(newFrame.contentWindow!, "postMessage").mockImplementation((value: unknown) =>
      transfer.resolve(value),
    );
    message(newFrame, ready(newFrame));
    oldAssets.resolve({ assets: [{ ref: "a.png", error: "not_found" }] });
    expect(await transfer.promise).toMatchObject({
      params: { html: '<img src="data:image/png;base64,Yg==">' },
    });
    await view.updateComplete;
    expect(oldPost).not.toHaveBeenCalled();
    expect(view.querySelector('.file-view__save-notice[role="status"]')).toBeNull();
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
    view.title += " ";
    await view.updateComplete;
    expect(request).toHaveBeenCalledOnce();
    view.querySelector("button")!.click();
    const frame = await frameFor(view);
    frame.dispatchEvent(new Event("error"));
    await view.updateComplete;
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    view.title += " ";
    await view.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    view.querySelector("button")!.click();
    await frameFor(view);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
