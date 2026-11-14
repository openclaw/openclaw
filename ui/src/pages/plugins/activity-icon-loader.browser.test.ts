import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPluginActivityIconBlobUrl as loadActivity,
  fetchPluginThemeArtworkBlobUrl as loadTheme,
} from "./icon-loader.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const svg = (body: string, attributes = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const square = '<path d="M4 4h16v16H4Z"/>';
const response = (body = svg(square), contentType = "image/svg+xml") =>
  new Response(body, { headers: { "content-type": contentType } });
const mockSvg = (body = square) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(svg(body)));
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
  afterEach(() => vi.restoreAllMocks());

  it("authenticates the activity route with exact tool names", async ({ onTestFinished }) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementation(async () => response());
    const url = await loadActivity({
      ...activityParams("custom-plugin"),
      auth: {
        hello: { auth: { deviceToken: "synthetic-stale-token" } },
        settings: { token: "synthetic-activity-token" },
      },
      tool: "mcp__custom__lookup",
    });
    expect(url).not.toBeNull();
    onTestFinished(() => URL.revokeObjectURL(url!));
    const route =
      "/openclaw/__openclaw__/plugin-activity-icon/custom-plugin?tool=mcp__custom__lookup";
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([route, route]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer synthetic-stale-token", "Bearer synthetic-activity-token"]);
  });

  it("recovers the same theme artwork URL after a transient fetch failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockImplementation(async () => response());
    const params = {
      ...common,
      url: "/__openclaw__/plugin-theme-art/test/theme/icon/mark?v=recover",
    };
    await expect(loadTheme(params)).resolves.toBeNull();
    const recovered = await loadTheme(params);
    expect(recovered).not.toBeNull();
  });

  it("rasterizes plugin theme artwork once per content URL, including concurrent callers", async () => {
    mockSvg();
    const params = { ...common, url: "/__openclaw__/plugin-theme-art/test/theme/hat/beret?v=1" };
    const [first, concurrent] = await Promise.all([loadTheme(params), loadTheme(params)]);
    expect(first).not.toBeNull();
    expect(concurrent).toBe(first);
    expect(await loadTheme(params)).toBe(first);
    const second = await loadTheme({ ...params, url: params.url.replace("v=1", "v=2") });
    expect(second).not.toBe(first);
  });

  it.for(["translate(1 2) scale(1.5)", "scale(1) ".repeat(40)])(
    "rasterizes valid transform %s",
    async (transform, { onTestFinished }) => {
      mockSvg(`<path d="M4 4h16v16H4Z" transform="${transform}"/>`);
      const url = await loadActivity(activityParams("valid-transform"));
      expect(url).not.toBeNull();
      onTestFinished(() => URL.revokeObjectURL(url!));
      const blob = await (await nativeFetch(url!)).blob();
      expect(blob.type).toBe("image/png");
      const image = await createImageBitmap(blob);
      onTestFinished(() => image.close());
      expect([image.width, image.height]).toEqual([256, 256]);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const alpha = context
        .getImageData(0, 0, image.width, image.height)
        .data.filter((_, i) => i % 4 === 3);
      expect(alpha.some((value) => value > 0)).toBe(true);
      expect(alpha.includes(0)).toBe(true);
    },
  );

  it("rejects an unclosed transform through the activity loader without stalling", async () => {
    mockSvg(`<path d="M4 4h16v16H4Z" transform="scale(${"\t\t)scale(".repeat(24)}"/>`);
    const started = performance.now();
    await expect(loadActivity(activityParams("stalling-transform"))).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each<[string, string, string?]>([
    ["package PNG", "png", "image/png"],
    ["active SVG", svg("<script>alert(1)</script>")],
    ["oversized element tree", svg("<path/>".repeat(4))],
    ["event attribute", svg(square, 'viewBox="0 0 24 24" onload="alert(1)"')],
    ["unknown attribute", svg(square, 'viewBox="0 0 24 24" href="https://example.test/icon"')],
    [
      "namespaced attribute",
      svg(square, 'viewBox="0 0 24 24" xmlns:other="urn:other" other:width="24"'),
    ],
    ["oversized view box", svg(square, 'viewBox="0 0 4097 24"')],
    ["oversized dimensions", svg(square, 'width="24" height="4097"')],
  ])("keeps %s out of compact activity", async (_name, body, contentType) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(body, contentType));
    await expect(loadActivity(activityParams("invalid-activity"))).resolves.toBeNull();
  });
});
