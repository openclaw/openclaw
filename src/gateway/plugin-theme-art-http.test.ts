import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThemeDefinitionFixture } from "../../test/helpers/theme-fixture.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { HTTP_SVG_MAX_BYTES } from "./http-image-response.js";
import { handlePluginThemeArtHttpRequest } from "./plugin-theme-art-http.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: authorize }));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v10H0z"/></svg>';
const ART_PATH = "/__openclaw__/plugin-theme-art/%40scope%2Fpack/neon/hat/beret";
// 1 × 1 lossless WebP.
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

function snapshot(svg = SVG, enabled = true, background = WEBP) {
  const artwork = {
    icons: { rocket: { svg } },
    hats: { beret: { svg } },
    critters: { ferris: { svg, title: "a crab, allegedly", crossMs: 15000 } },
    backgrounds: { dark: { base64: background.toString("base64") } },
  };
  const themeDefinitions = [{ id: "neon", definition: createThemeDefinitionFixture(), artwork }];
  const value = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "@scope/pack", themeDefinitions }],
  });
  value.index.plugins[0]!.enabled = enabled;
  return value;
}

async function request(
  pathname = ART_PATH,
  params: { method?: string; headers?: Record<string, string> } = {},
  captured = snapshot(),
) {
  const response = createResponse();
  const handled = await withPluginMetadataSnapshotScope(captured, () =>
    handlePluginThemeArtHttpRequest(createRequest({ path: pathname, ...params }), response.res, {
      auth: AUTH_TOKEN,
    }),
  );
  return { ...response, handled };
}

function expectImage(
  response: Awaited<ReturnType<typeof request>>,
  body: Buffer,
  type: string,
  filename: string,
) {
  expect(response.res.statusCode).toBe(200);
  expect(response.end).toHaveBeenCalledExactlyOnceWith(body);
  for (const header of Object.entries({
    "content-type": type,
    "content-length": String(body.byteLength),
    "cache-control": "private, max-age=3600",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
  })) {
    expect(response.setHeader).toHaveBeenCalledWith(...header);
  }
}

beforeEach(() => {
  authorize.mockReset();
  authorize.mockResolvedValue({ authMethod: "token", operatorScopes: ["operator.read"] });
});

describe("plugin theme artwork HTTP", () => {
  it("requires the shared Control UI read authorization before serving captured bytes", async () => {
    authorize.mockImplementationOnce(({ res }: { res: ServerResponse }) => {
      res.statusCode = 401;
      res.end("Unauthorized");
      return null;
    });
    const response = await request();
    expect(response.res.statusCode).toBe(401);
    expect(response.end).toHaveBeenCalledExactlyOnceWith("Unauthorized");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ auth: AUTH_TOKEN }));
  });

  it("serves captured icons, hats and critters with private caching, SVG sandboxing, HEAD and ETags", async () => {
    for (const pathname of [
      ART_PATH,
      ART_PATH.replace("hat/beret", "critter/ferris"),
      ART_PATH.replace("hat/beret", "icon/rocket"),
    ]) {
      const get = await request(`${pathname}?v=content-hash`);
      expectImage(get, Buffer.from(SVG), "image/svg+xml", "plugin-theme-art.svg");
      const etag = get.setHeader.mock.calls.find(([name]) => name === "etag")?.[1];
      expect(etag).toMatch(/^"[\w-]+"$/u);
      const head = await request(pathname, { method: "HEAD" });
      expect(head.res.statusCode).toBe(200);
      expect(head.setHeader).toHaveBeenCalledWith("etag", etag);
      expect(head.end).toHaveBeenCalledExactlyOnceWith(undefined);
      const cached = await request(pathname, { headers: { "if-none-match": `W/${etag}` } });
      expect(cached.res.statusCode).toBe(304);
      expect(cached.end).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it("serves captured raster backgrounds with the shared image policy", async () => {
    const pathname = ART_PATH.replace("hat/beret", "background/dark");
    const get = await request(`${pathname}?v=content-hash`);
    expectImage(get, WEBP, "image/webp", "plugin-theme-background");
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const rejected = await request(pathname, {}, snapshot(SVG, true, html));
    expect(rejected.res.statusCode).toBe(404);
  });

  it.each([
    ART_PATH.replace("hat/beret", "background/light"),
    ART_PATH.replace("hat/beret", "background/sepia"),
    ART_PATH.replace("hat/beret", "background/beret"),
    ART_PATH.replace("%40scope%2Fpack", "unknown"),
    ART_PATH.replace("hat", "unknown"),
    ART_PATH.replace("beret", "constructor"),
    ART_PATH.replace("hat/beret", "icon/constructor"),
    ART_PATH.replace("hat/beret", "icon/beret"),
    ART_PATH.replace("beret", "%zz"),
    ART_PATH.replace("beret", "%2F"),
    `${ART_PATH}/extra`,
  ])("returns 404 for unavailable or malformed artwork: %s", async (pathname) => {
    const response = await request(pathname);
    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
  });

  it("hides disabled plugins and observes newly published artwork", async () => {
    const before = snapshot();
    const nextSvg = SVG.replace("h20", "h30");
    const get = () => request(ART_PATH, {}, before);
    expect((await get()).end).toHaveBeenCalledWith(Buffer.from(SVG));
    expect((await request(ART_PATH, {}, snapshot(SVG, false))).res.statusCode).toBe(404);
    expect((await request(ART_PATH, {}, snapshot(nextSvg))).end).toHaveBeenCalledWith(
      Buffer.from(nextSvg),
    );
    expect((await get()).end).toHaveBeenCalledWith(Buffer.from(SVG));
  });

  it.each([
    ["oversized SVG", SVG + " ".repeat(HTTP_SVG_MAX_BYTES)],
    ["external reference", '<svg><image href="https://example.test/art.svg"/></svg>'],
  ])("revalidates %s through the shared image response owner", async (_label, svg) => {
    const response = await request(ART_PATH, {}, snapshot(svg));
    expect(response.res.statusCode).toBe(404);
  });

  it("rejects writes and leaves unrelated routes unhandled", async () => {
    const write = await request(ART_PATH, { method: "POST" });
    expect(write.res.statusCode).toBe(405);
    expect(write.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
    expect((await request("/__openclaw__/plugin-icon/pack")).handled).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("dispatches through the registered Gateway resource pipeline under its Control UI base path", async () => {
    await withGatewayServer({
      prefix: "plugin-theme-art-resource-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "/control",
        getRuntimeConfig: () => ({}),
      },
      run: async (gateway) =>
        withPluginMetadataSnapshotScope(snapshot(), async () => {
          const response = await sendRequest(gateway, { path: `/control${ART_PATH}` });
          expect(response.res.statusCode).toBe(200);
          expect(response.end).toHaveBeenCalledWith(Buffer.from(SVG));
        }),
    });
  });
});
