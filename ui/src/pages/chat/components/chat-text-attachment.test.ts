/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationContextRequest,
} from "../../../app/context.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.tsx";

type Attachment = Extract<SidebarContent, { kind: "attachment" }>;
const source = "/__openclaw__/assistant-media?mediaTicket=text-preview";
const pendingSelector = '[role="status"]:not([hidden])';
function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockReturnValueOnce(Promise.resolve(response));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const fetchResponse = (body: BodyInit) => mockFetch(new Response(body));
const expectText = (panel: ParentNode, selector: string, text: string) =>
  vi.waitFor(() => expect(panel.querySelector(selector)?.textContent).toBe(text));
const expectFallback = (panel: HTMLElement) =>
  vi.waitFor(() => expect(panel.textContent).toContain("Download it to read the full file"));

async function mountAttachment(
  overrides: Partial<Attachment> = {},
  request = async (_method: string, params: { html: string }) => ({
    html: params.html,
    sandboxUrl: "/mcp-app-sandbox?frames=none",
    sandboxPort: 8444,
  }),
) {
  const panel = document.createElement("openclaw-chat-detail-panel");
  const previewContext = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  panel.addEventListener("context-request", (event) => {
    // SAFETY: This listener handles the native application context protocol.
    const contextRequest = event as ApplicationContextRequest;
    if (
      contextRequest.context === applicationContext &&
      contextRequest.contextTarget.localName === "openclaw-chat-html-preview"
    ) {
      event.stopPropagation();
      contextRequest.callback(previewContext);
    }
  });
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "notes.txt",
    src: source,
    mimeType: "text/plain",
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  const query: typeof panel.querySelector = panel.querySelector.bind(panel);
  return { panel, query };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps one pending presentation through metadata and text-body loading", async () => {
  const body = createDeferred<Response>();
  const fetchMock = mockFetch(body.promise);
  let pending = true;
  const { panel, query } = await mountAttachment({
    src: undefined,
    resolveSource: () => (pending ? { status: "pending" } : { status: "ready", src: "/notes.txt" }),
  });
  await vi.waitFor(() => expect(query(pendingSelector)).not.toBeNull());
  const presentation = query(pendingSelector);
  const header = query(".chat-assistant-attachment-card__header");
  expect(fetchMock).not.toHaveBeenCalled();
  pending = false;
  panel.content = { ...panel.content };
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(query(pendingSelector)).toBe(presentation);
  expect(query(".chat-assistant-attachment-card__header")).toBe(header);
  body.resolve(new Response("Ready text"));
  await expectText(panel, "pre", "Ready text");
  expect(query(pendingSelector)).toBeNull();
});

it("retries a source-resolution failure through the attachment owner", async () => {
  fetchResponse("Recovered text");
  let ready = false;
  const { panel } = await mountAttachment({
    src: undefined,
    resolveSource: (onSourceChange) =>
      ready
        ? { status: "ready", src: "/recovered.txt" }
        : {
            status: "error",
            reason: "Temporarily unavailable",
            onRetry: () => {
              ready = true;
              onSourceChange();
            },
          },
  });
  await vi.waitFor(() => expect(panel.textContent).toContain("Temporarily unavailable"));
  const retry = Array.from(panel.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Retry",
  );
  expect(retry).toBeDefined();
  retry!.click();
  await expectText(panel, "pre", "Recovered text");
});

it.each([
  [
    "notes.txt",
    "text/plain",
    "Pasted notes 🦞\n  preserve indentation\n<script>not executable</script>\n",
  ],
  ["settings.json", "application/json", '{"ready":true}\n'],
  ["notes.txt", "application/octet-stream", "Text with generic metadata"],
  ["empty.txt", "", ""],
])("previews %s as literal text", async (title, mimeType, text) => {
  const fetchMock = fetchResponse(text);
  const { panel, query } = await mountAttachment({ title, mimeType });
  await expectText(panel, "pre", text);
  expect(query("script, iframe, textarea, h1, table")).toBeNull();
  expect(query("a[download]")?.getAttribute("href")).toBe(source);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
});

it.each([
  { title: "notes.md", mimeType: "text/markdown; charset=utf-8", kind: "document" },
  { title: "notes.markdown", mimeType: "application/octet-stream", kind: "document" },
  { title: "download", mimeType: "Text/X-Markdown; charset=UTF-8", kind: "document" },
  { title: "long.md", mimeType: "text/plain", kind: "long" },
  { title: "notes.md", mimeType: "text/plain", kind: "inert" },
])("renders $kind Markdown attachment $title ($mimeType)", async ({ title, mimeType, kind }) => {
  // Cross the message parse limit without creating thousands of paragraph elements.
  const text =
    kind === "long"
      ? `# Long document\n\n${"Paragraph of notes. ".repeat(2_100)}\n\n## Last section\n`
      : kind === "inert"
        ? "# שלום\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://example.com/tracking.png)\n"
        : "# Release notes\n\n**Ready** with [details](https://example.com).\n\n- First item\n\n| Feature | State |\n| --- | --- |\n| Sidebar | Ready |\n\n```ts\nconst ready = true;\n```\n";
  fetchResponse(text);
  const { panel, query } = await mountAttachment({ title, mimeType });
  if (kind === "long") {
    await expectText(panel, "article h2", "Last section");
    return;
  }
  await expectText(panel, "article h1", kind === "inert" ? "שלום" : "Release notes");
  const reader = query("article");
  if (kind === "inert") {
    expect(reader?.getAttribute("dir")).toBe("rtl");
    expect(reader?.querySelector("script, iframe, img, [onclick], [onerror]")).toBeNull();
    expect(reader?.querySelector('a[href^="javascript:"]')).toBeNull();
    return;
  }
  expect(reader?.querySelector("strong")?.textContent).toBe("Ready");
  expect(reader?.querySelector("li")?.textContent).toBe("First item");
  expect(reader?.querySelector("td")?.textContent).toBe("Sidebar");
  expect(reader?.querySelector("pre code")?.textContent).toBe("const ready = true;\n");
  expect(reader?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(query(".sidebar-attachment-preview__text")).toBeNull();
  expect(query("a[download]")).not.toBeNull();
});

it.each([
  { title: "archive.bin", mimeType: "application/octet-stream" },
  { title: "notes.txt", src: "https://files.example/notes.txt" },
  { title: "page.html", mimeType: "text/html", src: "https://files.example/page.html" },
])("does not fetch unsupported or external documents: $title $mimeType $src", async (content) => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment(content);
  expect(panel.querySelector("pre")).toBeNull();
  expect(panel.querySelector("a[download]")).not.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

type RejectedAttachment = {
  failure: "metadata" | "advertised" | "streamed" | "bytes" | "unavailable" | "timeout";
  content?: Partial<Attachment>;
  bytes?: Uint8Array<ArrayBuffer>;
};

const plainFile = { title: "notes.txt", mimeType: "text/plain" };
const htmlFile = { title: "page.html", mimeType: "text/html" };

it.each<RejectedAttachment>([
  { failure: "metadata", content: plainFile },
  { failure: "metadata", content: { ...htmlFile, plainText: true } },
  { failure: "advertised", content: plainFile },
  { failure: "streamed", content: plainFile },
  { failure: "bytes", bytes: new Uint8Array([0xff]) },
  { failure: "bytes", bytes: new Uint8Array([0x61, 0x00, 0x62]) },
  { failure: "unavailable" },
  { failure: "timeout" },
])("falls back to download for $failure: $content $bytes", async ({ failure, content, bytes }) => {
  const limit = 256 * 1024;
  const fetchMock = vi.fn<typeof fetch>();
  const cancel = vi.fn();
  const streamed = failure === "advertised" || failure === "streamed";
  if (streamed || failure === "timeout") {
    if (failure === "timeout") {
      vi.useFakeTimers();
    }
    fetchMock.mockImplementation(async (_input, init) => {
      const stream = new ReadableStream({
        start(controller) {
          if (streamed) {
            controller.enqueue(new Uint8Array(limit + 1));
          } else {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          }
        },
        cancel,
      });
      const headers = failure === "advertised" ? { "Content-Length": String(limit + 1) } : {};
      return new Response(stream, { headers });
    });
  } else if (failure === "bytes") {
    fetchMock.mockResolvedValue(new Response(bytes));
  } else if (failure === "unavailable") {
    fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
  }
  vi.stubGlobal("fetch", fetchMock);
  const { panel, query } = await mountAttachment({
    ...content,
    sizeBytes: failure === "metadata" ? limit + 1 : streamed ? 1 : undefined,
  });
  if (failure === "timeout") {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(panel.textContent).toContain("Download it to read the full file");
  } else {
    await expectFallback(panel);
  }
  if (failure === "metadata") {
    expect(fetchMock).not.toHaveBeenCalled();
  } else {
    expect(query("pre")).toBeNull();
  }
  if (streamed) {
    expect(cancel).toHaveBeenCalledOnce();
    expect(query("a[download]")).not.toBeNull();
  }
});

it.each(["same", "different"])(
  "aborts and discards superseded %s-identity reads",
  async (identity) => {
    const old = createDeferred<Response>();
    const fetchMock = mockFetch(old.promise, new Response("Current file"));
    const { panel, query } = await mountAttachment({ sourceIdentity: "attachment:notes" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    panel.content = {
      kind: "attachment",
      title: "next.txt",
      src: "/next.txt",
      mimeType: "text/plain",
      sourceIdentity: identity === "same" ? "attachment:notes" : "attachment:next",
    };
    await expectText(panel, "pre", "Current file");
    expect(signal?.aborted).toBe(true);
    old.resolve(new Response("Old file"));
    await vi.waitFor(() => expect(fetchMock.mock.settledResults[0]?.type).toBe("fulfilled"));
    await query("openclaw-chat-text-attachment")?.updateComplete;
    expect(query("pre")?.textContent).toBe("Current file");
  },
);

it("aborts a closed preview and reloads it after remount", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    )
    .mockResolvedValueOnce(new Response("Reloaded text"));
  vi.stubGlobal("fetch", fetchMock);
  const { panel } = await mountAttachment();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  await waitForSolid(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  document.body.append(panel);
  await expectText(panel, "pre", "Reloaded text");
});

it.each([
  { title: "large.HTM", mimeType: "application/octet-stream", fill: "a", suffix: "" },
  { title: "download", mimeType: "Text/HTML; charset=UTF-8", sizeBytes: 1, fill: "🦀", suffix: "" },
  { title: "large.html", mimeType: "text/html", fill: "🦀", suffix: "a" },
])("bounds streamed UTF-8 HTML $title ($fill, $suffix)", async ({ fill, suffix, ...content }) => {
  const text = fill.repeat((2 * 1024 * 1024) / new TextEncoder().encode(fill).byteLength) + suffix;
  fetchResponse(text);
  const { panel, query } = await mountAttachment(content);
  if (suffix) {
    await expectFallback(panel);
    expect(query("openclaw-chat-html-preview")).toBeNull();
    expect(panel.textContent).toContain("2 MiB");
  } else {
    await vi.waitFor(() => expect(query("openclaw-chat-html-preview")).not.toBeNull());
    expect(query("pre")?.textContent).toBe(text);
  }
});

it.each([
  { title: "page.html", mimeType: "text/html", change: { plainText: true } },
  { title: "download", mimeType: "text/html", change: { mimeType: "text/plain" } },
  { title: "page.html", mimeType: "text/plain", change: { title: "notes.txt" } },
])("revalidates retained HTML after $change", async ({ change, ...content }) => {
  const text = "x".repeat(256 * 1024 + 1);
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(text));
  vi.stubGlobal("fetch", fetchMock);
  const { panel, query } = await mountAttachment({
    ...content,
    sourceIdentity: "retained",
    sizeBytes: text.length,
  });
  await expectText(panel, "pre", text);
  const reader = query("openclaw-chat-text-attachment");
  panel.content = { ...panel.content, ...change };
  await vi.waitFor(() =>
    expect(panel.textContent).toContain("Text previews require UTF-8 files up to 256 KiB"),
  );
  expect(query("openclaw-chat-text-attachment")).toBe(reader);
  expect(query("pre, openclaw-chat-html-preview")).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  ["page.HTM", "application/octet-stream"],
  ["download", "Text/HTML; charset=UTF-8"],
])("sandboxes HTML %s (%s), preserving exact Source and download", async (title, mimeType) => {
  const text =
    "\ufeff<!doctype html>\r\n<style>h1{color:red}</style><h1>Rendered page</h1><script>window.ready=true</script>\n";
  fetchResponse(text);
  const request = vi.fn().mockResolvedValue({
    html: text,
    sandboxUrl: "/mcp-app-sandbox?frames=none",
    sandboxPort: 8444,
  });
  const { panel, query } = await mountAttachment({ title, mimeType }, request);
  await customElements.whenDefined("openclaw-chat-html-preview");
  await waitForSolid(() => expect(query("openclaw-chat-html-preview")).not.toBeNull());
  await waitForSolid(() => expect(query("iframe")).not.toBeNull());
  const frame = query("iframe");
  expect(query("h1, script, style")).toBeNull();
  expect(query("pre")).toMatchObject({ hidden: true, textContent: text });
  const toggle = query<HTMLButtonElement>(".sidebar-file-toolbar button[aria-pressed]")!;
  expect(toggle.textContent?.trim()).toBe("Source");
  toggle.click();
  await query("openclaw-chat-text-attachment")!.updateComplete;
  expect(query("pre")?.hidden).toBe(false);
  expect(query(".chat-html-preview")?.hasAttribute("hidden")).toBe(true);
  expect(toggle.textContent?.trim()).toBe("Preview");
  toggle.click();
  await query("openclaw-chat-text-attachment")!.updateComplete;
  expect(query("iframe")).toBe(frame);
  expect(request).toHaveBeenCalledOnce();
  expect(query("a[download]")?.getAttribute("href")).toBe(source);
  Reflect.set(panel, "embedSandboxMode", "strict");
  await waitForSolid(() => {
    const current = query("iframe");
    expect(current).not.toBeNull();
    expect(current).not.toBe(frame);
  });
  const strictFrame = query("iframe")!;
  expect(strictFrame.hasAttribute("srcdoc")).toBe(false);
  expect(strictFrame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
  const post = vi.spyOn(strictFrame.contentWindow!, "postMessage");
  window.dispatchEvent(
    new MessageEvent("message", {
      source: strictFrame.contentWindow,
      origin: new URL(strictFrame.src).origin,
      data: {
        method: "ui/notifications/sandbox-proxy-ready",
        params: { sandboxUrl: strictFrame.src },
      },
    }),
  );
  await waitForSolid(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0]![0].params).toEqual({
    html: text,
    renderId: expect.any(String),
    allowScripts: false,
  });
});
