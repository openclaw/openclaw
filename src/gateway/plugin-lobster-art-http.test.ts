import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLobsterPackDefinition } from "../../packages/gateway-protocol/src/lobsterdex.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { handlePluginLobsterArtHttpRequest } from "./plugin-lobster-art-http.js";
import { AUTH_TOKEN, createRequest, createResponse } from "./server-http.test-harness.js";

const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: authorize }));
const source = path.resolve("examples/plugins/lobster-pack");
const definition = normalizeLobsterPackDefinition(
  JSON.parse(fs.readFileSync(path.join(source, "reef.json"), "utf8")),
);
const artwork = Object.fromEntries(
  definition.clawmojis.map((entry) => [
    entry.id,
    {
      data: fs.readFileSync(path.join(source, entry.appearance.source)).toString("base64"),
      mimeType: entry.appearance.kind === "svg" ? "image/svg+xml" : "image/png",
    },
  ]),
);
const ART_PATH = "/__openclaw__/plugin-lobster-art/reef-lobsters/reef/coral";
function snapshot(enabled = true) {
  const value = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "reef-lobsters", lobsterDefinitions: [{ id: "reef", definition, artwork }] }],
  });
  value.index.plugins[0]!.enabled = enabled;
  return value;
}
async function request(
  pathname = ART_PATH,
  params: { method?: string; headers?: Record<string, string>; basePath?: string } = {},
) {
  const response = createResponse();
  const handled = await handlePluginLobsterArtHttpRequest(
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
describe("Lobster Pack artwork HTTP", () => {
  it("authorizes before resolving artwork", async () => {
    authorize.mockImplementationOnce(({ res }: { res: ServerResponse }) => {
      res.statusCode = 401;
      res.end("Unauthorized");
      return null;
    });
    const response = await withPluginMetadataSnapshotScope(snapshot(), () => request());
    expect(response.res.statusCode).toBe(401);
    expect(response.end).toHaveBeenCalledExactlyOnceWith("Unauthorized");
  });
  it.each(["coral", "tide"])(
    "serves captured %s artwork with HEAD, ETag and sandbox headers",
    async (id) => {
      await withPluginMetadataSnapshotScope(snapshot(), async () => {
        const url = ART_PATH.replace("coral", id);
        const get = await request(url);
        expect(get.res.statusCode).toBe(200);
        expect(get.end).toHaveBeenCalledExactlyOnceWith(Buffer.from(artwork[id]!.data, "base64"));
        expect(get.setHeader).toHaveBeenCalledWith("content-type", artwork[id]!.mimeType);
        expect(get.setHeader).toHaveBeenCalledWith(
          "content-security-policy",
          expect.stringContaining("sandbox"),
        );
        expect(get.setHeader).toHaveBeenCalledWith("x-content-type-options", "nosniff");
        const etag = get.setHeader.mock.calls.find(([name]) => name === "etag")?.[1];
        const head = await request(url, { method: "HEAD" });
        expect(head.res.statusCode).toBe(200);
        expect(head.end).toHaveBeenCalledExactlyOnceWith(undefined);
        const cached = await request(url, { headers: { "if-none-match": String(etag) } });
        expect(cached.res.statusCode).toBe(304);
        expect((await request(`/openclaw${url}`, { basePath: "/openclaw" })).res.statusCode).toBe(
          200,
        );
      });
    },
  );
  it.each([
    `${ART_PATH}/extra`,
    ART_PATH.replace("coral", "%2F"),
    ART_PATH.replace("coral", "constructor"),
    ART_PATH.replace("reef-lobsters", "missing"),
  ])("rejects malformed or unavailable artwork %s", async (url) => {
    expect(
      (await withPluginMetadataSnapshotScope(snapshot(), () => request(url))).res.statusCode,
    ).toBe(404);
  });
  it("hides disabled assets and declines unsupported methods", async () => {
    expect(
      (await withPluginMetadataSnapshotScope(snapshot(false), () => request())).res.statusCode,
    ).toBe(404);
    expect(
      (
        await withPluginMetadataSnapshotScope(snapshot(), () =>
          request(ART_PATH, { method: "POST" }),
        )
      ).res.statusCode,
    ).toBe(405);
    expect((await request("/unrelated")).handled).toBe(false);
  });
});
