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
function load(path: string, enabled = () => true) {
  return loadControlUiLinkPreview(new URL(path, "https://public.example"), enabled);
}

afterEach(() => {
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

  it("shares in-flight anonymous reads and caches unavailable results", async () => {
    const gate = createDeferred<Response>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) =>
        requestUrl(input).endsWith("/favicon.ico")
          ? new Response(null, { status: 404 })
          : gate.promise,
      );
    vi.stubGlobal("fetch", fetch);
    const first = load("/shared");
    const second = load("/shared");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    gate.resolve(new Response(null, { status: 404 }));
    expect(await first).toEqual({});
    expect(await second).toEqual({});
    expect(await load("/shared")).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
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
