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

  it.each([
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
