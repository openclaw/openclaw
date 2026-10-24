import type { ImportGlobFunction } from "vite/types/importGlob.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fetchPluginActivityIconBlobUrl as loadActivity,
  fetchPluginThemeArtworkBlobUrl as loadTheme,
} from "./icon-loader.ts";

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
const svg = (body: string, attributes = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const square = '<path d="M4 4h16v16H4Z"/>';
const svgResponse = () =>
  new Response(svg(square), { headers: { "content-type": "image/svg+xml" } });
const common = {
  auth: { settings: { token: "synthetic-activity-token" } },
  resourceBasePath: "/openclaw",
  gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
};
const activityParams = (pluginId: string) => ({
  ...common,
  pluginId,
  signal: new AbortController().signal,
});

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

  beforeAll(() => vi.stubGlobal("fetch", fetchGlyph));

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
    async ([path, , pluginId], { expect: expectGlyph, onTestFinished }) => {
      const url = await loadActivity(activityParams(pluginId));
      expectGlyph(url, path).not.toBeNull();
      if (!url) {
        return;
      }
      onTestFinished(() => URL.revokeObjectURL(url));
      const blob = await (await nativeFetch(url)).blob();
      expectGlyph(blob.type, path).toBe("image/png");
      const image = await createImageBitmap(blob);
      onTestFinished(() => image.close());
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const alpha = pixels.filter((_, index) => index % 4 === 3);
      const visible = alpha.some((value) => value > 0);
      expectGlyph(visible, path).toBe(true);
      expectGlyph(alpha.includes(0), path).toBe(true);
    },
  );

  it("authenticates the activity route with exact tool names", async ({ onTestFinished }) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(svgResponse());
    const url = await loadActivity({
      ...activityParams("custom-plugin"),
      auth: {
        hello: { auth: { deviceToken: "synthetic-stale-token" } },
        settings: { token: "synthetic-activity-token" },
      },
      tool: "mcp__custom__lookup",
    });
    expect(url).not.toBeNull();
    if (url) {
      onTestFinished(() => URL.revokeObjectURL(url));
    }
    const route =
      "/openclaw/__openclaw__/plugin-activity-icon/custom-plugin?tool=mcp__custom__lookup";
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([route, route]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer synthetic-stale-token", "Bearer synthetic-activity-token"]);
  });

  it("recovers the same theme artwork URL after a transient fetch failure", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockImplementation(async () => svgResponse());
    const params = {
      ...common,
      url: "/__openclaw__/plugin-theme-art/test/theme/icon/mark?v=recover",
    };
    await expect(loadTheme(params)).resolves.toBeNull();
    const recovered = await loadTheme(params);
    expect(recovered).not.toBeNull();
    expect(await loadTheme(params)).toBe(recovered);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rasterizes plugin theme artwork once per content URL, including concurrent callers", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => svgResponse());
    const params = { ...common, url: "/__openclaw__/plugin-theme-art/test/theme/hat/beret?v=1" };
    const [first, concurrent] = await Promise.all([loadTheme(params), loadTheme(params)]);
    expect(first).not.toBeNull();
    expect(concurrent).toBe(first);
    expect(await loadTheme(params)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const blob = await (await nativeFetch(first!)).blob();
    expect(blob.type).toBe("image/png");
    const bitmap = await createImageBitmap(blob);
    expect([bitmap.width, bitmap.height]).toEqual([256, 256]);
    bitmap.close();
    const nextUrl = params.url.replace("v=1", "v=2");
    const second = await loadTheme({ ...params, url: nextUrl });
    expect(second).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, string, string]>([
    ["package PNG", "image/png", "png"],
    ["active SVG", "image/svg+xml", svg("<script>alert(1)</script>")],
    ["oversized element tree", "image/svg+xml", svg("<path/>".repeat(4))],
    ...(
      [
        ["event attribute", 'viewBox="0 0 24 24" onload="alert(1)"'],
        ["unknown attribute", 'viewBox="0 0 24 24" href="https://example.test/icon"'],
        ["namespaced attribute", 'viewBox="0 0 24 24" xmlns:other="urn:other" other:width="24"'],
        ["oversized view box", 'viewBox="0 0 4097 24"'],
        ["oversized dimensions", 'width="24" height="4097"'],
      ] satisfies Array<[string, string]>
    ).map(([name, attributes]): [string, string, string] => [
      name,
      "image/svg+xml",
      svg(square, attributes),
    ]),
  ])("keeps %s out of compact activity", async (_name, contentType, body) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(body, { headers: { "content-type": contentType } }),
    );
    await expect(loadActivity(activityParams("invalid-activity"))).resolves.toBeNull();
  });
});
