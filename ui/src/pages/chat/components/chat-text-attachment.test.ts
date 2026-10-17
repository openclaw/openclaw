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
const fetchResponse = (body: BodyInit) =>
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
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
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps one pending presentation through metadata and text-body loading", async () => {
  const body = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockReturnValue(body.promise);
  vi.stubGlobal("fetch", fetchMock);
  let pending = true;
  const panel = await mountAttachment({
    src: undefined,
    resolveSource: () => (pending ? { status: "pending" } : { status: "ready", src: "/notes.txt" }),
  });
  await vi.waitFor(() => expect(panel.querySelector(pendingSelector)).not.toBeNull());
  const presentation = panel.querySelector(pendingSelector);
  const header = panel.querySelector(".chat-assistant-attachment-card__header");
  expect(fetchMock).not.toHaveBeenCalled();
  pending = false;
  panel.content = { ...panel.content };
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(panel.querySelector(pendingSelector)).toBe(presentation);
  expect(panel.querySelector(".chat-assistant-attachment-card__header")).toBe(header);
  body.resolve(new Response("Ready text"));
  await expectText(panel, "pre", "Ready text");
  expect(panel.querySelector(pendingSelector)).toBeNull();
});

it("retries a source-resolution failure through the attachment owner", async () => {
  fetchResponse("Recovered text");
  let ready = false;
  const panel = await mountAttachment({
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
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ title, mimeType });
  await expectText(panel, "pre", text);
  expect(panel.querySelector("script, iframe, textarea, h1, table")).toBeNull();
  expect(panel.querySelector("a[download]")?.getAttribute("href")).toBe(source);
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
  const panel = await mountAttachment({ title, mimeType });
  if (kind === "long") {
    await expectText(panel, "article h2", "Last section");
    return;
  }
  await expectText(panel, "article h1", kind === "inert" ? "שלום" : "Release notes");
  const reader = panel.querySelector("article");
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
  expect(panel.querySelector(".sidebar-attachment-preview__text")).toBeNull();
  expect(panel.querySelector("a[download]")).not.toBeNull();
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
  limit?: number;
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
])(
  "preserves the download fallback for $failure: $content $bytes",
  async ({ failure, content, limit = 256 * 1024, bytes }) => {
    const fetchMock = vi.fn<typeof fetch>();
    const cancel = vi.fn();
    if (failure === "advertised" || failure === "streamed") {
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(limit + 1));
            },
            cancel,
          }),
          { headers: failure === "advertised" ? { "Content-Length": String(limit + 1) } : {} },
        ),
      );
    } else if (failure === "bytes") {
      fetchMock.mockResolvedValue(new Response(bytes));
    } else if (failure === "unavailable") {
      fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
    } else if (failure === "timeout") {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        async (_input, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                );
              },
            }),
          ),
      );
    }
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({
      ...content,
      sizeBytes:
        failure === "metadata"
          ? limit + 1
          : failure === "advertised" || failure === "streamed"
            ? 1
            : undefined,
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
      expect(panel.querySelector("pre")).toBeNull();
    }
    if (failure === "advertised" || failure === "streamed") {
      expect(cancel).toHaveBeenCalledOnce();
      expect(panel.querySelector("a[download]")).not.toBeNull();
    }
  },
);

it.each(["same", "different"])(
  "aborts a superseded read for the %s identity and never displays its late contents",
  async (identity) => {
    const old = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(new Response("Current file"));
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({ sourceIdentity: "attachment:notes" });
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
    await panel.querySelector("openclaw-chat-text-attachment")?.updateComplete;
    expect(panel.querySelector("pre")?.textContent).toBe("Current file");
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
  const panel = await mountAttachment();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  await waitForSolid(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  document.body.append(panel);
  await expectText(panel, "pre", "Reloaded text");
});

it.each([
  {
    title: "large.HTM",
    mimeType: "application/octet-stream",
    sizeBytes: undefined,
    fill: "a",
    suffix: "",
  },
  { title: "download", mimeType: "Text/HTML; charset=UTF-8", sizeBytes: 1, fill: "🦀", suffix: "" },
  { title: "large.html", mimeType: "text/html", sizeBytes: undefined, fill: "🦀", suffix: "a" },
])(
  "enforces streamed UTF-8 bytes for large HTML $title ($sizeBytes, $fill, $suffix)",
  async ({ fill, suffix, ...content }) => {
    const text =
      fill.repeat((2 * 1024 * 1024) / new TextEncoder().encode(fill).byteLength) + suffix;
    fetchResponse(text);
    const panel = await mountAttachment(content);
    if (suffix) {
      await expectFallback(panel);
      expect(panel.querySelector("openclaw-chat-html-preview")).toBeNull();
      expect(panel.textContent).toContain("2 MiB");
    } else {
      await vi.waitFor(() =>
        expect(panel.querySelector("openclaw-chat-html-preview")).not.toBeNull(),
      );
      expect(panel.querySelector("pre")?.textContent).toBe(text);
    }
  },
);

it.each([
  { title: "page.html", mimeType: "text/html", change: { plainText: true } },
  { title: "download", mimeType: "text/html", change: { mimeType: "text/plain" } },
  { title: "page.html", mimeType: "text/plain", change: { title: "notes.txt" } },
])(
  "revalidates retained HTML after classification changes: $change",
  async ({ change, ...content }) => {
    const text = "x".repeat(256 * 1024 + 1);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(text));
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({
      ...content,
      sourceIdentity: "retained",
      sizeBytes: text.length,
    });
    await expectText(panel, "pre", text);
    const reader = panel.querySelector("openclaw-chat-text-attachment");
    panel.content = { ...panel.content, ...change };
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Text previews require UTF-8 files up to 256 KiB"),
    );
    expect(panel.querySelector("openclaw-chat-text-attachment")).toBe(reader);
    expect(panel.querySelector("pre, openclaw-chat-html-preview")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

it.each([
  ["page.HTM", "application/octet-stream"],
  ["download", "Text/HTML; charset=UTF-8"],
])(
  "renders HTML attachment %s (%s) in a sandbox and preserves exact Source and download",
  async (title, mimeType) => {
    const text =
      "\ufeff<!doctype html>\r\n<style>h1{color:red}</style><h1>Rendered page</h1><script>window.ready=true</script>\n";
    fetchResponse(text);
    const request = vi.fn().mockResolvedValue({
      html: text,
      sandboxUrl: "/mcp-app-sandbox?frames=none",
      sandboxPort: 8444,
    });
    const panel = await mountAttachment({ title, mimeType }, request);
    await customElements.whenDefined("openclaw-chat-html-preview");
    await waitForSolid(() =>
      expect(panel.querySelector("openclaw-chat-html-preview")).not.toBeNull(),
    );
    await waitForSolid(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const frame = panel.querySelector("iframe");
    expect(panel.querySelector("h1, script, style")).toBeNull();
    expect(panel.querySelector("pre")?.hidden).toBe(true);
    expect(panel.querySelector("pre")?.textContent).toBe(text);
    const toggle = panel.querySelector<HTMLButtonElement>(
      ".sidebar-file-toolbar button[aria-pressed]",
    )!;
    expect(toggle.textContent?.trim()).toBe("Source");
    toggle.click();
    await panel.querySelector("openclaw-chat-text-attachment")!.updateComplete;
    expect(panel.querySelector("pre")?.hidden).toBe(false);
    expect(panel.querySelector(".chat-html-preview")?.hasAttribute("hidden")).toBe(true);
    expect(toggle.textContent?.trim()).toBe("Preview");
    toggle.click();
    await panel.querySelector("openclaw-chat-text-attachment")!.updateComplete;
    expect(panel.querySelector("iframe")).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
    expect(panel.querySelector("a[download]")?.getAttribute("href")).toBe(source);
    Reflect.set(panel, "embedSandboxMode", "strict");
    await waitForSolid(() => {
      const current = panel.querySelector("iframe");
      expect(current).not.toBeNull();
      expect(current).not.toBe(frame);
    });
    const strictFrame = panel.querySelector("iframe")!;
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
  },
);
