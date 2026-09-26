/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

async function mountAttachment(
  overrides: Partial<Extract<SidebarContent, { kind: "attachment" }>> = {},
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: SidebarContent;
    updateComplete: Promise<unknown>;
  };
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

it("reads a text attachment in Files without downloading or interpreting its contents", async () => {
  const text = "Pasted notes 🦞\n  preserve indentation\n<script>not executable</script>\n";
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment();

  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
  expect(panel.querySelector("script, iframe, textarea")).toBeNull();
  expect(panel.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(
    "/__openclaw__/assistant-media?mediaTicket=text-preview",
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
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
  ["rows.csv", "text/csv", "name,status\nalpha,ready\n"],
  ["settings.json", "application/json", '{"ready":true}\n'],
  ["config.xml", "application/xml", "<ready>true</ready>"],
  ["notes.txt", "application/octet-stream", "Text with generic metadata"],
  ["empty.txt", "", ""],
])("previews %s as literal text", async (title, mimeType, text) => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title, mimeType });
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
  expect(panel.querySelector("iframe, h1, table")).toBeNull();
});

it.each([
  ["notes.md", "text/markdown; charset=utf-8"],
  ["notes.MD", "text/plain"],
  ["notes.markdown", "application/octet-stream"],
  ["notes.md", ""],
  ["download", "Text/X-Markdown; charset=UTF-8"],
  ["notes.txt", "text/markdown"],
])("renders Markdown attachment %s (%s) as a document", async (title, mimeType) => {
  const text =
    "# Release notes\n\n**Ready** with [details](https://example.com).\n\n- First item\n\n| Feature | State |\n| --- | --- |\n| Sidebar | Ready |\n\n```ts\nconst ready = true;\n```\n";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title, mimeType });
  await vi.waitFor(() =>
    expect(panel.querySelector("article h1")?.textContent).toBe("Release notes"),
  );
  const reader = panel.querySelector("article");
  expect(reader?.querySelector("strong")?.textContent).toBe("Ready");
  expect(reader?.querySelector("li")?.textContent).toBe("First item");
  expect(reader?.querySelector("td")?.textContent).toBe("Sidebar");
  expect(reader?.querySelector("pre code")?.textContent).toBe("const ready = true;\n");
  expect(reader?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(panel.querySelector(".sidebar-attachment-preview__text")).toBeNull();
  expect(panel.querySelector("a[download]")).not.toBeNull();
});

it("renders bounded Markdown documents beyond the chat message parse limit", async () => {
  const text = `# Long document\n\n${"Paragraph of notes.\n\n".repeat(2_100)}## Last section\n`;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title: "long.md" });
  await vi.waitFor(() =>
    expect(panel.querySelector("article h2")?.textContent).toBe("Last section"),
  );
});

it("keeps Markdown attachment markup inert and does not load remote images", async () => {
  const text =
    "# שלום\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://example.com/tracking.png)\n";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title: "notes.md" });
  await vi.waitFor(() => expect(panel.querySelector("article h1")?.textContent).toBe("שלום"));
  const reader = panel.querySelector("article");
  expect(reader?.getAttribute("dir")).toBe("rtl");
  expect(reader?.querySelector("script, iframe, img, [onclick], [onerror]")).toBeNull();
  expect(reader?.querySelector('a[href^="javascript:"]')).toBeNull();
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

it.each([
  { title: "notes.txt", mimeType: "text/plain", limit: 256 * 1024 },
  { title: "page.html", mimeType: "text/html", limit: 2 * 1024 * 1024 },
  { title: "page.html", mimeType: "text/html", plainText: true, limit: 256 * 1024 },
])(
  "declines an oversized $title (plainText=$plainText) without fetching",
  async ({ limit, ...content }) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({ ...content, sizeBytes: limit + 1 });
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Download it to read the full file"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  { sizeSource: "advertised", title: "notes.txt", mimeType: "text/plain", limit: 256 * 1024 },
  { sizeSource: "streamed", title: "notes.txt", mimeType: "text/plain", limit: 256 * 1024 },
  { sizeSource: "advertised", title: "page.html", mimeType: "text/html", limit: 2 * 1024 * 1024 },
  { sizeSource: "streamed", title: "page.html", mimeType: "text/html", limit: 2 * 1024 * 1024 },
])(
  "cancels $sizeSource oversized $title responses and preserves download",
  async ({ sizeSource, limit, ...content }) => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(limit + 1));
        },
        cancel,
      }),
      { headers: sizeSource === "advertised" ? { "Content-Length": String(limit + 1) } : {} },
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    const panel = await mountAttachment({ ...content, sizeBytes: 1 });
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Download it to read the full file"),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(panel.querySelector("pre")).toBeNull();
    expect(panel.querySelector("a[download]")).not.toBeNull();
  },
);

it.each([new Uint8Array([0xff]), new Uint8Array([0x61, 0x00, 0x62])])(
  "does not lossily decode non-text bytes",
  async (bytes) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));
    const panel = await mountAttachment();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Download it to read the full file"),
    );
    expect(panel.querySelector("pre")).toBeNull();
  },
);

it("shows a download fallback for an unavailable response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 403 })),
  );
  const panel = await mountAttachment();
  await vi.waitFor(() => expect(panel.textContent).toContain("Download it to read the full file"));
  expect(panel.querySelector("pre")).toBeNull();
});

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
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Reloaded text"));
});

it("times out even when a response stalls while reading its body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(
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
    ),
  );
  const panel = await mountAttachment();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(panel.textContent).toContain("Download it to read the full file");
  expect(panel.querySelector("pre")).toBeNull();
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
  ["page.html", "text/html"],
  ["page.HTM", "application/octet-stream"],
  ["page.html", ""],
  ["download", "Text/HTML; charset=UTF-8"],
])(
  "renders HTML attachment %s (%s) in a sandbox and preserves exact Source and download",
  async (title, mimeType) => {
    const text =
      "\ufeff<!doctype html>\r\n<style>h1{color:red}</style><h1>Rendered page</h1><script>window.ready=true</script>\n";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
    const panel = await mountAttachment({ title, mimeType });
    await customElements.whenDefined("openclaw-chat-html-preview");
    await expect.poll(() => panel.querySelector("openclaw-chat-html-preview")).not.toBeNull();
    const preview = panel.querySelector("openclaw-chat-html-preview")!;
    const request = vi.fn().mockResolvedValue({
      html: text,
      sandboxUrl: "/mcp-app-sandbox?frames=none",
      sandboxPort: 8444,
    });
    Reflect.set(preview, "context", {
      gateway: {
        snapshot: { client: { request }, phase: "connected" },
        connection: { gatewayUrl: "ws://gateway.example:8443" },
        subscribe: () => () => {},
      },
    });
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
