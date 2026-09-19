import type { ImportGlobFunction } from "vite/types/importGlob.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPluginActivityIconBlobUrl } from "./icon-loader.ts";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.runIf("__vitest_browser__" in globalThis)("plugin activity icon decoder", () => {
  const assets = Object.entries(bundledActivityIcons);

  it("includes shipped activity glyphs", () => {
    expect(assets.length).toBeGreaterThan(0);
  });

  it.each(assets)(
    "decodes %s through the bounded SVG loader into a transparent PNG mask",
    async (path, source) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(source, {
              headers: { "content-type": "image/svg+xml" },
            }),
        ),
      );
      const url = await fetchPluginActivityIconBlobUrl({
        ...common,
        pluginId: "synthetic-plugin",
        signal: new AbortController().signal,
      });
      expect(url, path).not.toBeNull();
      if (!url) {
        return;
      }
      try {
        const blob = await (await nativeFetch(url)).blob();
        expect(blob.type, path).toBe("image/png");
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
          expect(visible, path).toBeGreaterThan(0);
          expect(transparent, path).toBeGreaterThan(0);
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
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4Z"/></svg>',
          {
            headers: { "content-type": "image/svg+xml" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetch);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": contentType },
          }),
      ),
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
