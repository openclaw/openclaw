import type { ImportGlobFunction } from "vite/types/importGlob.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchPluginActivityIconBlobUrl, fetchPluginThemeArtworkBlobUrl } from "./icon-loader.ts";

declare global {
  interface ImportMeta {
    glob: ImportGlobFunction;
  }
}

const bundledActivityIcons = import.meta.glob<string>(
  [
    "../../../../extensions/*/assets/activity.svg",
    "../../../../extensions/*/assets/activity/*.svg",
  ],
  { eager: true, query: "?raw", import: "default" },
);
const nativeFetch = globalThis.fetch.bind(globalThis);
const common = {
  auth: { settings: { token: "synthetic-activity-token" } },
  resourceBasePath: "/openclaw",
  gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
};

describe.runIf("__vitest_browser__" in globalThis)("plugin activity icon decoder", () => {
  const assets = Object.entries(bundledActivityIcons).map(
    ([path, source], index) => [path, source, `synthetic-plugin-${index}`] as const,
  );
  const sourceByRoute = new Map(
    assets.map(([, source, pluginId]) => [
      new URL(`/openclaw/__openclaw__/plugin-activity-icon/${pluginId}`, window.location.origin)
        .href,
      source,
    ]),
  );

  const fetchGlyph: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.origin);
    const source = sourceByRoute.get(url.href);
    if (source === undefined) {
      throw new Error(`Unexpected activity glyph route: ${url.href}`);
    }
    return new Response(source, { headers: { "content-type": "image/svg+xml" } });
  };

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchGlyph);
  });

  afterEach(({ task }) => {
    if (!task.concurrent) {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", fetchGlyph);
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("includes shipped activity glyphs", () => {
    expect(assets.length).toBeGreaterThan(0);
  });

  it.concurrent.for(assets)(
    "decodes %s through the bounded SVG loader into a transparent PNG mask",
    async ([path, , pluginId], { expect: expectGlyph }) => {
      const url = await fetchPluginActivityIconBlobUrl({
        ...common,
        pluginId,
        signal: new AbortController().signal,
      });
      expectGlyph(url, path).not.toBeNull();
      if (!url) {
        return;
      }
      try {
        const blob = await (await nativeFetch(url)).blob();
        expectGlyph(blob.type, path).toBe("image/png");
        const image = await createImageBitmap(blob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, image.width, image.height).data;
          let visible = 0;
          let transparent = 0;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] === 0) {
              transparent++;
            } else {
              visible++;
            }
          }
          expectGlyph(visible, path).toBeGreaterThan(0);
          expectGlyph(transparent, path).toBeGreaterThan(0);
        } finally {
          image.close();
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  );

  it("authenticates the distinct activity route and preserves exact tool names", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4Z"/></svg>',
          {
            headers: { "content-type": "image/svg+xml" },
          },
        ),
      );
    const url = await fetchPluginActivityIconBlobUrl({
      ...common,
      auth: {
        hello: { auth: { deviceToken: "synthetic-stale-token" } },
        settings: { token: "synthetic-activity-token" },
      },
      pluginId: "custom-plugin",
      tool: "mcp__custom__lookup",
      signal: new AbortController().signal,
    });
    try {
      expect(url).not.toBeNull();
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        "/openclaw/__openclaw__/plugin-activity-icon/custom-plugin?tool=mcp__custom__lookup",
        "/openclaw/__openclaw__/plugin-activity-icon/custom-plugin?tool=mcp__custom__lookup",
      ]);
      expect(
        fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
      ).toEqual(["Bearer synthetic-stale-token", "Bearer synthetic-activity-token"]);
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  });

  it("recovers the same theme artwork URL after a transient fetch failure", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockImplementation(
        async () =>
          new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff0000" d="M4 4h16v16H4Z"/></svg>',
            { headers: { "content-type": "image/svg+xml" } },
          ),
      );
    const params = {
      ...common,
      url: "/__openclaw__/plugin-theme-art/test/theme/icon/mark?v=recover",
    };
    await expect(fetchPluginThemeArtworkBlobUrl(params)).resolves.toBeNull();
    const recovered = await fetchPluginThemeArtworkBlobUrl(params);
    expect(recovered).not.toBeNull();
    expect(await fetchPluginThemeArtworkBlobUrl(params)).toBe(recovered);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rasterizes plugin theme artwork once per content URL, including concurrent callers", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff0000" d="M4 4h16v16H4Z"/></svg>',
            { headers: { "content-type": "image/svg+xml" } },
          ),
      );
    const params = { ...common, url: "/__openclaw__/plugin-theme-art/test/theme/hat/beret?v=1" };
    const [first, concurrent] = await Promise.all([
      fetchPluginThemeArtworkBlobUrl(params),
      fetchPluginThemeArtworkBlobUrl(params),
    ]);
    expect(first).not.toBeNull();
    expect(concurrent).toBe(first);
    expect(await fetchPluginThemeArtworkBlobUrl(params)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const blob = await (await nativeFetch(first!)).blob();
    expect(blob.type).toBe("image/png");
    const bitmap = await createImageBitmap(blob);
    expect([bitmap.width, bitmap.height]).toEqual([256, 256]);
    bitmap.close();
    const second = await fetchPluginThemeArtworkBlobUrl({
      ...params,
      url: params.url.replace("v=1", "v=2"),
    });
    expect(second).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rasterizes an ordinary transform and a long valid transform list", async ({
    onTestFinished,
  }) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockImplementation(
      async () =>
        new Response(wrapSvg('<path d="M4 4h16v16H4Z" transform="translate(1 2) scale(1.5)"/>'), {
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    const ordinary = await fetchPluginActivityIconBlobUrl({
      ...common,
      pluginId: "ordinary-transform",
      signal: new AbortController().signal,
    });
    expect(ordinary).not.toBeNull();
    onTestFinished(() => URL.revokeObjectURL(ordinary!));
    const ordinaryBlob = await (await nativeFetch(ordinary!)).blob();
    expect(ordinaryBlob.type).toBe("image/png");

    fetch.mockImplementation(
      async () =>
        new Response(wrapSvg(`<path d="M4 4h16v16H4Z" transform="${"scale(1) ".repeat(40)}"/>`), {
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    const longList = await fetchPluginActivityIconBlobUrl({
      ...common,
      pluginId: "long-transform",
      signal: new AbortController().signal,
    });
    expect(longList).not.toBeNull();
    onTestFinished(() => URL.revokeObjectURL(longList!));
    const longBlob = await (await nativeFetch(longList!)).blob();
    expect(longBlob.type).toBe("image/png");
  });

  it("rejects an unclosed transform through the activity loader without stalling", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          wrapSvg(`<path d="M4 4h16v16H4Z" transform="scale(${"\t\t)scale(".repeat(24)}"/>`),
          { headers: { "content-type": "image/svg+xml" } },
        ),
    );
    const started = performance.now();
    await expect(
      fetchPluginActivityIconBlobUrl({
        ...common,
        pluginId: "stalling-transform",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each<[string, string, string]>([
    ["package PNG", "image/png", "png"],
    [
      "active SVG",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    ],
    [
      "oversized element tree",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path/><path/><path/><path/></svg>',
    ],
    ...(
      [
        ["event attribute", 'viewBox="0 0 24 24" onload="alert(1)"'],
        ["unknown attribute", 'viewBox="0 0 24 24" href="https://example.test/icon"'],
        ["namespaced attribute", 'viewBox="0 0 24 24" xmlns:other="urn:other" other:width="24"'],
        ["oversized view box", 'viewBox="0 0 4097 24"'],
        ["oversized dimensions", 'width="24" height="4097"'],
      ] as const
    ).map(([name, attributes]): [string, string, string] => [
      name,
      "image/svg+xml",
      `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><path d="M4 4h16v16H4Z"/></svg>`,
    ]),
  ])("keeps %s out of compact activity", async (_name, contentType, body) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(body, {
          headers: { "content-type": contentType },
        }),
    );
    await expect(
      fetchPluginActivityIconBlobUrl({
        ...common,
        pluginId: "invalid-activity",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });
});

function wrapSvg(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
}
