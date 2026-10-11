import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const encode = vi.hoisted(() => vi.fn());
vi.mock("../media/image-ops.js", async (original) => ({
  ...(await original<typeof import("../media/image-ops.js")>()),
  createImageProcessor: () => ({ encode }),
}));
const { loadControlUiLinkPreview, parseControlUiLinkPreviewUrl } =
  await import("./control-ui-link-preview.js");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function html(text: string) {
  return new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
}
const principal = {};
function load(path: string, enabled = () => true, scope = principal, revision = 0) {
  return loadControlUiLinkPreview(
    parseControlUiLinkPreviewUrl(new URL(path, "https://public.example").href)!,
    enabled,
    {
      principal: scope,
      revision,
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  encode.mockReset();
});

describe("public link previews", () => {
  it.each([
    "javascript:alert(1)",
    "https://u:p@public.example/a",
    "http://[::1]",
    "https://metadata.google.internal/",
    "https://8.8.8.8/",
    "x".repeat(2049),
  ])("rejects unsafe target %s", (value) => {
    expect(parseControlUiLinkPreviewUrl(value)).toBeNull();
  });

  it("uses redirected-page OG metadata, document base URLs, entity decoding and anonymous requests", async () => {
    encode.mockResolvedValue({ data: PNG });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/metadata")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/story/index.html" },
        });
      }
      if (url.endsWith("index.html")) {
        return html(
          '<html><head><base href="https://assets.example/brand/"><base href="https://ignored.example/"><title>Fallback</title><meta content="A &amp; B" property="og:title"><meta name="twitter:image" content="/wrong.png"><meta content="../cover.png?x=1&amp;y=2" property="og:image"><link href="./icon.png" rel="shortcut icon"></head></html>',
        );
      }
      return new Response(PNG);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await load("/metadata#fragment")).toEqual({
      title: "A & B",
      imageDataUrl: pngUrl,
      faviconDataUrl: pngUrl,
    });
    expect(fetch.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "https://public.example/metadata",
      "https://cdn.example/story/index.html",
      "https://assets.example/cover.png?x=1&y=2",
      "https://assets.example/brand/icon.png",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe("omit");
      const headers = new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("referer")).toBe(false);
    }
    expect(encode).toHaveBeenCalledWith(
      PNG,
      expect.objectContaining({
        format: "png",
        resize: { maxSide: 640, fit: "inside", enlarge: false },
      }),
    );
  });

  it.each([
    {
      name: "open-graph description",
      tags: '<meta name="description" content="Fallback"><meta name="twitter:description" content="Twitter"><meta property="og:description" content=" A &amp; B   guide ">',
      expected: { description: "A & B guide" },
    },
    {
      name: "twitter description",
      tags: '<meta name="description" content="Fallback"><meta name="twitter:description" content="Twitter">',
      expected: { description: "Twitter" },
    },
    {
      name: "bounded standard description",
      tags: '<meta name="description" content="' + "x".repeat(399) + '😀tail">',
      expected: { description: "x".repeat(399) },
    },
    {
      name: "twitter title and ICO fallback",
      tags: '<meta name="twitter:title" content="Tweet title"><meta name="twitter:image" content="javascript:alert(1)"><link rel="icon" type="image/svg+xml" href="/unsafe.svg">',
      icon: ICO,
      expected: {
        title: "Tweet title",
        faviconDataUrl: `data:image/x-icon;base64,${ICO.toString("base64")}`,
      },
    },
    {
      name: "bounded HTML and oversized or disguised images",
      tags: '<title>Bounded</title><meta property="og:image" content="/huge.png">',
      body: "x".repeat(600 * 1024),
      icon: '<svg onload="alert(1)"></svg>',
      expected: { title: "Bounded" },
    },
  ])(
    "extracts $name without decoding unsafe images",
    async ({ name, tags, expected, icon, body }) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/favicon.ico")) {
          return icon
            ? new Response(
                icon,
                typeof icon === "string" ? { headers: { "content-type": "image/png" } } : undefined,
              )
            : new Response(null, { status: 404 });
        }
        if (body && url.endsWith("/huge.png")) {
          return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
        }
        return html("<html><head>" + tags + "</head><body>" + (body ?? "") + "</body></html>");
      });
      vi.stubGlobal("fetch", fetch);
      expect(await load("/metadata-" + encodeURIComponent(name))).toEqual(expected);
      expect(fetch).toHaveBeenCalledTimes(body ? 3 : 2);
      expect(encode).not.toHaveBeenCalled();
    },
  );

  it.each(["http://127.0.0.1/internal", "https://u:p@public.example/private"])(
    "guards page and image redirect %s before fetching it",
    async (destination) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (url.includes("/page-redirect") || url.endsWith("/evil.png")) {
          return new Response(null, { status: 302, headers: { location: destination } });
        }
        if (url.endsWith("/favicon.ico")) {
          return new Response(null, { status: 404 });
        }
        return html(
          '<head><title>Good</title><meta property="og:image" content="/evil.png"></head>',
        );
      });
      vi.stubGlobal("fetch", fetch);
      expect(await load("/page-redirect?target=" + encodeURIComponent(destination))).toEqual({});
      expect(await load("/image-redirect?target=" + encodeURIComponent(destination))).toEqual({
        title: "Good",
      });
      expect(fetch.mock.calls.some(([url]) => requestUrl(url) === destination)).toBe(false);
      expect(encode).not.toHaveBeenCalled();
    },
  );

  it.each(["</head>", "<body>"])(
    "stops reading at a split %s without treating inert markup as a head boundary",
    async (boundary) => {
      const chunks = [
        Buffer.from(
          '<html><head><!-- </head><meta property="og:title" content="Wrong"> -->' +
            '<script>const tag = "</head>";</script><style>/* </head> */</style>' +
            "<title>A &am",
        ),
        Buffer.from("p; B</title>" + boundary.slice(0, 3)),
        Buffer.from(boundary.slice(3)),
        Buffer.from('<meta property="og:title" content="Body">' + "x".repeat(128 * 1024)),
      ];
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        const chunk = chunks.shift();
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) =>
          requestUrl(input).endsWith("/favicon.ico")
            ? new Response(null, { status: 404 })
            : new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
                headers: { "content-type": "text/html" },
              }),
        ),
      );
      expect(await load("/streamed-" + encodeURIComponent(boundary))).toEqual({ title: "A & B" });
      expect(pull).toHaveBeenCalledTimes(3);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("limits an unterminated head to 64 KiB before late metadata", async () => {
    const prefix = "<head><title>Early</title><!--";
    const bytes = Buffer.from(
      prefix +
        "x".repeat(64 * 1024 - prefix.length) +
        '--><meta property="og:title" content="Too late"></head>',
    );
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(bytes);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) =>
        requestUrl(input).endsWith("/favicon.ico")
          ? new Response(null, { status: 404 })
          : new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
              headers: { "content-type": "text/html" },
            }),
      ),
    );
    expect(await load("/unterminated-head")).toEqual({ title: "Early" });
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "successful", ttl: 60 * 60_000, result: { title: "Cached" } },
    { name: "unavailable", ttl: 5 * 60_000, result: {} },
  ])(
    "expires $name previews by URL while coalescing fragment variants",
    async ({ name, ttl, result }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (input) =>
          requestUrl(input).endsWith("/favicon.ico") || name === "unavailable"
            ? new Response(null, { status: 404 })
            : html("<head><title>Cached</title></head>"),
        );
      vi.stubGlobal("fetch", fetch);
      const path = "/cache-ttl-" + name;
      expect(await load(path)).toEqual(result);
      now.mockReturnValue(1_000 + ttl - 1);
      expect(await load(path + "#fragment")).toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(2);
      now.mockReturnValue(1_000 + ttl);
      expect(await load(path)).toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it("shares in-flight anonymous reads and caches unavailable results", async () => {
    const gate = createDeferred<Response>();
    const requested = createDeferred();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      requested.resolve();
      return requestUrl(input).endsWith("/favicon.ico")
        ? new Response(null, { status: 404 })
        : gate.promise;
    });
    vi.stubGlobal("fetch", fetch);
    const first = load("/shared");
    const second = load("/shared");
    await requested.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve(new Response(null, { status: 404 }));
    expect(await first).toEqual({});
    expect(await second).toEqual({});
    expect(await load("/shared")).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not share cached or in-flight previews across principals or revisions", async () => {
    const gate = createDeferred<Response>();
    const requested = createDeferred();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).endsWith("/favicon.ico")) {
        return new Response(null, { status: 404 });
      }
      if (fetch.mock.calls.length === 1) {
        requested.resolve();
        return gate.promise;
      }
      return html("<head><title>Current</title></head>");
    });
    vi.stubGlobal("fetch", fetch);
    const first = load("/scoped");
    await requested.promise;
    const second = load("/scoped", () => true, {});
    gate.resolve(html("<head><title>Original</title></head>"));
    expect(await second).toEqual({ title: "Current" });
    expect(await first).toEqual({ title: "Original" });
    expect(await load("/scoped")).toEqual({ title: "Original" });
    expect(await load("/scoped", () => true, principal, 1)).toEqual({ title: "Current" });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("fetches a shared social image and favicon only once while sizing each output", async () => {
    encode.mockResolvedValue({ data: PNG });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) =>
        requestUrl(input).endsWith("/shared-image")
          ? html(
              '<head><meta property="og:image" content="/image.png"><link rel="icon" href="/image.png"></head>',
            )
          : new Response(PNG),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await load("/shared-image")).toEqual({ imageDataUrl: pngUrl, faviconDataUrl: pngUrl });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      encode.mock.calls.map(([, options]) => options.resize.maxSide).toSorted((a, b) => a - b),
    ).toEqual([64, 640]);
  });

  it("bounds queue wait by the preview deadline and never fetches an expired queued URL", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const gate = createDeferred();
    const started = createDeferred();
    let active = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (++active === 4) {
        started.resolve();
      }
      await gate.promise;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = Array.from({ length: 4 }, (_, i) => load(`/busy-${i}`));
    await started.promise;
    let result: unknown;
    const queued = load("/expired-in-queue").then((preview) => {
      result = preview;
    });
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(result).toEqual({});
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      gate.resolve();
      await Promise.all([...pending, queued]);
    }
    expect(fetch.mock.calls.some(([url]) => requestUrl(url).includes("expired-in-queue"))).toBe(
      false,
    );
  });

  it("does no work while disabled, including cached previews; disabling during HTML stops images", async () => {
    let enabled = false;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      enabled = false;
      return html('<head><meta property="og:image" content="/never.png"></head>');
    });
    vi.stubGlobal("fetch", fetch);
    expect(await load("/disabled", () => enabled)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    enabled = true;
    expect(await load("/disabled", () => enabled)).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await load("/metadata#fragment", () => enabled)).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
