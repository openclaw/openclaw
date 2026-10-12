/* @vitest-environment jsdom */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.tsx";

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

async function mountAttachment(
  overrides: Partial<Extract<SidebarContent, { kind: "attachment" }>> = {},
  request = async (_method: string, params: { html: string }) => ({
    html: params.html,
    sandboxUrl: "/mcp-app-sandbox?frames=none",
    sandboxPort: 8444,
  }),
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: SidebarContent;
    updateComplete: Promise<unknown>;
  };
  const previewContext = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  panel.addEventListener("context-request", (event) => {
    if (
      event.context === applicationContext &&
      event.contextTarget.localName === "openclaw-chat-html-preview"
    ) {
      event.stopPropagation();
      event.callback(previewContext);
    }
  });
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "notes.txt",
    src: "/__openclaw__/assistant-media?mediaTicket=text-preview",
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
  let resolveBody!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        resolveBody = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  let pending = true;
  const panel = await mountAttachment({
    src: undefined,
    resolveSource: () => (pending ? { status: "pending" } : { status: "ready", src: "/notes.txt" }),
  });
  await vi.waitFor(() =>
    expect(panel.querySelector('[role="status"]:not([hidden])')).not.toBeNull(),
  );
  const presentation = panel.querySelector('[role="status"]:not([hidden])');
  const header = panel.querySelector(".chat-assistant-attachment-card__header");
  expect(fetchMock).not.toHaveBeenCalled();
  pending = false;
  panel.content = { ...panel.content };
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(panel.querySelector('[role="status"]:not([hidden])')).toBe(presentation);
  expect(panel.querySelector(".chat-assistant-attachment-card__header")).toBe(header);
  resolveBody(new Response("Ready text"));
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Ready text"));
  expect(panel.querySelector('[role="status"]:not([hidden])')).toBeNull();
});

it("retries a source-resolution failure through the attachment owner", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Recovered text")));
  let ready = false;
  const panel = await mountAttachment({
    src: undefined,
    resolveSource: (requestUpdate) =>
      ready
        ? { status: "ready", src: "/recovered.txt" }
        : {
            status: "error",
            reason: "Temporarily unavailable",
            onRetry: () => {
              ready = true;
              requestUpdate();
            },
          },
  });
  await vi.waitFor(() => expect(panel.textContent).toContain("Temporarily unavailable"));
  const retry = Array.from(panel.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Retry",
  );
  expect(retry).toBeDefined();
  retry!.click();
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Recovered text"));
});

it.each([
  [
    "notes.txt",
    "text/plain",
    "Pasted notes 🦞\n  preserve indentation\n<script>not executable</script>\n",
  ],
  ["settings.json", "application/json", '{"ready":true}\n'],
  ["config.xml", "application/xml", "<ready>true</ready>"],
  ["notes.txt", "application/octet-stream", "Text with generic metadata"],
  ["empty.txt", "", ""],
])("previews %s as literal text", async (title, mimeType, text) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ title, mimeType });
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
  expect(panel.querySelector("script, iframe, textarea, h1, table")).toBeNull();
  expect(panel.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(
    "/__openclaw__/assistant-media?mediaTicket=text-preview",
  );
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
  const text =
    kind === "long"
      ? `# Long document\n\n${"Paragraph of notes.\n\n".repeat(2_100)}## Last section\n`
      : kind === "inert"
        ? "# שלום\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://example.com/tracking.png)\n"
        : "# Release notes\n\n**Ready** with [details](https://example.com).\n\n- First item\n\n| Feature | State |\n| --- | --- |\n| Sidebar | Ready |\n\n```ts\nconst ready = true;\n```\n";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title, mimeType });
  if (kind === "long") {
    await vi.waitFor(() =>
      expect(panel.querySelector("article h2")?.textContent).toBe("Last section"),
    );
    return;
  }
  await vi.waitFor(() =>
    expect(panel.querySelector("article h1")?.textContent).toBe(
      kind === "inert" ? "שלום" : "Release notes",
    ),
  );
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
  content?: Partial<Extract<SidebarContent, { kind: "attachment" }>>;
  limit?: number;
  bytes?: Uint8Array<ArrayBuffer>;
};

const plainFile = { title: "notes.txt", mimeType: "text/plain" };
const htmlFile = { title: "page.html", mimeType: "text/html" };

it.each<RejectedAttachment>([
  { failure: "metadata", content: plainFile },
  { failure: "metadata", content: htmlFile, limit: 2 * 1024 * 1024 },
  { failure: "metadata", content: { ...htmlFile, plainText: true } },
  { failure: "advertised", content: plainFile },
  { failure: "streamed", content: plainFile },
  { failure: "advertised", content: htmlFile, limit: 2 * 1024 * 1024 },
  { failure: "streamed", content: htmlFile, limit: 2 * 1024 * 1024 },
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
      await vi.waitFor(() =>
        expect(panel.textContent).toContain("Download it to read the full file"),
      );
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
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
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
    await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Current file"));
    expect(signal?.aborted).toBe(true);
    resolveOld(new Response("Old file"));
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
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Reloaded text"));
});

it.each([
  { title: "large.html", mimeType: "text/html", sizeBytes: 2 * 1024 * 1024, fill: "a", suffix: "" },
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
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
    const panel = await mountAttachment(content);
    if (suffix) {
      await vi.waitFor(() =>
        expect(panel.textContent).toContain("Download it to read the full file"),
      );
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
    await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
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
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
    const request = vi.fn().mockResolvedValue({
      html: text,
      sandboxUrl: "/mcp-app-sandbox?frames=none",
      sandboxPort: 8444,
    });
    const panel = await mountAttachment({ title, mimeType }, request);
    await customElements.whenDefined("openclaw-chat-html-preview");
    await expect.poll(() => panel.querySelector("openclaw-chat-html-preview")).not.toBeNull();
    await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
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
    expect(panel.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(
      "/__openclaw__/assistant-media?mediaTicket=text-preview",
    );
    Reflect.set(panel, "embedSandboxMode", "strict");
    await expect
      .poll(() => {
        const current = panel.querySelector("iframe");
        return current !== null && current !== frame;
      })
      .toBe(true);
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
    await expect.poll(() => post.mock.calls.length).toBe(1);
    expect(post.mock.calls[0]![0].params).toEqual({
      html: text,
      renderId: expect.any(String),
      allowScripts: false,
    });
  },
);

it("does not hang the attachment preview when a real HTTP 403 body cancel stays pending", async () => {
  let requestCount = 0;
  let retainedUnread: Response | undefined;
  let cancelCalled = false;
  let cancelSettled = false;
  const server = createServer((_request, response) => {
    requestCount += 1;
    // Keep the error body open; an unread clone() tee branch makes cancel()
    // stay pending until that branch also cancels or the remote ends.
    response.writeHead(403, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": "1048576",
    });
    response.write("denied-preview-body");
  });
  const baseUrl = await listenOnLoopback(server);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await nativeFetch(new URL(requestUrl, baseUrl), init);
    // Native fetch settles cancel immediately for an un-cloned response; retain
    // an unread tee branch so the production cancel stays genuinely pending.
    retainedUnread = response.clone();
    const body = response.body;
    if (body) {
      const nativeCancel = body.cancel.bind(body);
      body.cancel = (reason?: unknown) => {
        cancelCalled = true;
        const pending = nativeCancel(reason);
        void Promise.resolve(pending)
          .catch(() => undefined)
          .finally(() => {
            cancelSettled = true;
          });
        return pending;
      };
    }
    return response;
  });
  try {
    const panel = await mountAttachment();
    await vi.waitFor(
      () => expect(panel.textContent).toContain("Download it to read the full file"),
      { timeout: 2_000 },
    );
    expect(panel.querySelector("pre")).toBeNull();
    expect(requestCount).toBe(1);
    expect(cancelCalled).toBe(true);
    expect(cancelSettled).toBe(false);
    expect(retainedUnread?.body).toBeTruthy();
    console.log(
      `[attachment 403 cancel hang proof] transport=node:http+fetch request_count=${requestCount} cancel_called=true cancel_settled=false fallback_before_cancel_settled=true hung=false fallback=true`,
    );
  } finally {
    await retainedUnread?.body?.cancel().catch(() => undefined);
    await closeServer(server);
  }
});
