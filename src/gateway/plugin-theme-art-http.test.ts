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

function snapshot(svg = SVG, enabled = true) {
  const value = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "@scope/pack",
        themeDefinitions: [
          {
            id: "neon",
            definition: createThemeDefinitionFixture(),
            artwork: {
              hats: { beret: { svg } },
              critters: { ferris: { svg, title: "a crab, allegedly", crossMs: 15000 } },
            },
          },
        ],
      },
    ],
  });
  value.index.plugins[0]!.enabled = enabled;
  return value;
}

async function request(
  pathname = ART_PATH,
  params: { method?: string; headers?: Record<string, string>; basePath?: string } = {},
) {
  const response = createResponse();
  const handled = await handlePluginThemeArtHttpRequest(
    createRequest({ path: pathname, method: params.method, headers: params.headers }),
    response.res,
    { auth: AUTH_TOKEN, basePath: params.basePath },
  );
  return { ...response, handled };
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
    const response = await withPluginMetadataSnapshotScope(snapshot(), () => request());
    expect(response.res.statusCode).toBe(401);
    expect(response.end).toHaveBeenCalledExactlyOnceWith("Unauthorized");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ auth: AUTH_TOKEN }));
  });

  it("serves captured hats and critters with private caching, SVG sandboxing, HEAD and ETags", async () => {
    await withPluginMetadataSnapshotScope(snapshot(), async () => {
      for (const pathname of [ART_PATH, ART_PATH.replace("hat/beret", "critter/ferris")]) {
        const get = await request(`${pathname}?v=content-hash`);
        expect(get.res.statusCode).toBe(200);
        expect(get.end).toHaveBeenCalledExactlyOnceWith(Buffer.from(SVG));
        for (const header of [
          ["content-type", "image/svg+xml"],
          ["content-length", String(Buffer.byteLength(SVG))],
          ["cache-control", "private, max-age=3600"],
          ["cross-origin-resource-policy", "same-origin"],
          ["x-content-type-options", "nosniff"],
          ["content-disposition", 'attachment; filename="plugin-theme-art.svg"'],
          [
            "content-security-policy",
            "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
          ],
        ]) {
          expect(get.setHeader).toHaveBeenCalledWith(...header);
        }
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
  });

  it.each([
    ART_PATH.replace("%40scope%2Fpack", "unknown"),
    ART_PATH.replace("neon", "unknown"),
    ART_PATH.replace("hat", "unknown"),
    ART_PATH.replace("beret", "unknown"),
    ART_PATH.replace("beret", "constructor"),
    ART_PATH.replace("beret", "%zz"),
    ART_PATH.replace("beret", "%2F"),
    `${ART_PATH}/extra`,
    "/__openclaw__/plugin-theme-art/",
  ])("returns 404 for unavailable or malformed artwork: %s", async (pathname) => {
    const response = await withPluginMetadataSnapshotScope(snapshot(), () => request(pathname));
    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
  });

  it("hides disabled plugins and observes newly published artwork", async () => {
    const before = snapshot();
    const nextSvg = SVG.replace("h20", "h30");
    const after = snapshot(nextSvg);
    const get = () => withPluginMetadataSnapshotScope(before, () => request());
    expect((await get()).end).toHaveBeenCalledWith(Buffer.from(SVG));
    expect(
      (await withPluginMetadataSnapshotScope(snapshot(SVG, false), () => request())).res.statusCode,
    ).toBe(404);
    expect(
      (await withPluginMetadataSnapshotScope(after, () => request())).end,
    ).toHaveBeenCalledWith(Buffer.from(nextSvg));
    expect((await get()).end).toHaveBeenCalledWith(Buffer.from(SVG));
  });

  it.each([
    ["oversized SVG", SVG + " ".repeat(HTTP_SVG_MAX_BYTES)],
    ["external reference", '<svg><image href="https://example.test/art.svg"/></svg>'],
    ["script", "<svg><script>alert(1)</script></svg>"],
    ["empty bytes", ""],
  ])("revalidates %s through the shared image response owner", async (_label, svg) => {
    const response = await withPluginMetadataSnapshotScope(snapshot(svg), () => request());
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
