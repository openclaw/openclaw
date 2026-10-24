import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";

const mocks = vi.hoisted(() => ({
  fetchMetadata: vi.fn<typeof fetch>(),
  readRemoteMediaBuffer: vi.fn(),
  resolveIconSource: vi.fn(),
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeControlUiReadRequestOrReply: ({ res }: { res: ServerResponse }) =>
    bindHttpResponseAuthority(
      { authMethod: "token", operatorScopes: ["operator.admin", "operator.read"] },
      res,
      () => true,
    ),
}));

vi.mock("../media/fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/fetch.js")>()),
  readRemoteMediaBuffer: (...args: unknown[]) => mocks.readRemoteMediaBuffer(...args),
}));

vi.mock("../media/image-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/image-ops.js")>()),
  createImageProcessor: () => ({
    encode: async () => ({ data: Buffer.from("normalized-png") }),
  }),
}));

vi.mock("../plugins/management-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-service.js")>()),
  resolveManagedPluginIconSources: (...args: unknown[]) => mocks.resolveIconSource(...args),
}));

const { clearPluginIconCacheForTest, handlePluginIconHttpRequest } =
  await import("./plugin-icon-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const packageName = "@acme/calendar";
const packageMetadata = {
  name: packageName,
  displayName: "Calendar",
  family: "code-plugin",
  isOfficial: false,
};
const source = { kind: "clawhub", baseUrl: "https://clawhub.ai", packageName };
const packageUrl = "https://cdn.example.test/package.png";
const publisherUrl = "https://cdn.example.test/publisher.png";
const metadataUrl = "https://clawhub.ai/api/v1/packages/%40acme%2Fcalendar";
const realFetch = globalThis.fetch;
const fixtureDirs = useAutoCleanupTempDirTracker(afterAll);
const iconFixtureDir = fixtureDirs.make("openclaw-plugin-clawhub-icon-");
const localIconPath = path.join(iconFixtureDir, "icon.png");
const server = createServer((req, res) => {
  void handlePluginIconHttpRequest(req, res, {
    auth: { mode: "token", token: "test-token", allowTailscale: false },
    config: {},
  })
    .then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    })
    .catch(() => finishFailedGatewayHttpResponse(res));
});
let port = 0;

beforeAll(async () => {
  port = Number(new URL(await listenLoopback(server)).port);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  clearPluginIconCacheForTest();
  vi.clearAllMocks();
  writeFileSync(localIconPath, PNG_BYTES);
  mocks.resolveIconSource.mockReset().mockResolvedValue([source]);
  mocks.fetchMetadata.mockReset().mockImplementation(async () =>
    Response.json({
      package: { ...packageMetadata, icon: packageUrl },
      owner: { image: publisherUrl },
    }),
  );
  mocks.readRemoteMediaBuffer.mockReset().mockResolvedValue({
    buffer: PNG_BYTES,
    contentType: "image/png",
  });
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === metadataUrl) {
      return mocks.fetchMetadata(input, init);
    }
    if (url.origin === `http://127.0.0.1:${port}`) {
      return realFetch(input, init);
    }
    throw new Error(`Unexpected icon fixture request: ${url.origin}${url.pathname}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

async function request(method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}/__openclaw__/plugin-icon/calendar`, {
    method,
    headers: { Authorization: "Bearer test-token" },
  });
  await response.arrayBuffer();
  return response;
}

function expectPublicMetadataRequest() {
  expect(mocks.fetchMetadata).toHaveBeenCalledOnce();
  const call = mocks.fetchMetadata.mock.calls[0];
  const input = call?.[0];
  expect(input instanceof Request ? input.url : input instanceof URL ? input.href : input).toBe(
    metadataUrl,
  );
  expect(new Headers(call?.[1]?.headers).has("Authorization")).toBe(false);
}

describe("ClawHub branding through the public icon route", () => {
  it.each([null, `/api/v1/skill-icons/${"a".repeat(64)}`, "https://cdn.example/icon.png"])(
    "reads package icon %s and publisher image in order through one exact public request",
    async (icon) => {
      const image = "https://cdn.example/publisher.png";
      mocks.fetchMetadata.mockImplementation(async () =>
        Response.json({ package: { ...packageMetadata, icon }, owner: { image } }),
      );
      mocks.readRemoteMediaBuffer.mockImplementation(async ({ url }) => {
        if (url !== image) {
          throw new Error("Package icon unavailable");
        }
        return { buffer: PNG_BYTES, contentType: "image/png" };
      });

      expect((await request()).status).toBe(200);
      expect(mocks.readRemoteMediaBuffer.mock.calls.map(([params]) => params.url)).toEqual(
        icon ? [icon.startsWith("/") ? `https://clawhub.ai${icon}` : icon, image] : [image],
      );
      expectPublicMetadataRequest();
    },
  );

  it("rejects a different returned package identity before fetching an image", async () => {
    mocks.fetchMetadata.mockImplementation(async () =>
      Response.json({ package: { ...packageMetadata, name: "@other/calendar", icon: packageUrl } }),
    );

    expect((await request()).status).toBe(404);
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expectPublicMetadataRequest();
  });

  it.each(["package", "publisher", "missing"])(
    "tries local, remote package, then publisher images and caches the successful %s result",
    async (outcome) => {
      writeFileSync(localIconPath, "invalid local image");
      mocks.resolveIconSource.mockResolvedValue([
        { kind: "file", path: localIconPath, rootPath: iconFixtureDir },
        source,
      ]);
      mocks.readRemoteMediaBuffer.mockImplementation(async ({ url }) => {
        if (outcome === "missing" || (outcome === "publisher" && url === packageUrl)) {
          throw new Error("Image unavailable");
        }
        return { buffer: PNG_BYTES, contentType: "image/png" };
      });

      const response = await request();
      expect(response.status).toBe(outcome === "missing" ? 404 : 200);
      expectPublicMetadataRequest();
      expect(mocks.readRemoteMediaBuffer.mock.calls.map(([params]) => params.url)).toEqual(
        outcome === "package" ? [packageUrl] : [packageUrl, publisherUrl],
      );
      if (outcome !== "missing") {
        const cached = await request("HEAD");
        expect(cached.status).toBe(200);
        expect(cached.headers.get("etag")).toBe(response.headers.get("etag"));
        expect(mocks.fetchMetadata).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not read remote metadata when the local package icon succeeds", async () => {
    mocks.resolveIconSource.mockResolvedValue([
      { kind: "file", path: localIconPath, rootPath: iconFixtureDir },
      source,
    ]);
    expect((await request()).status).toBe(200);
    expect(mocks.fetchMetadata).not.toHaveBeenCalled();
  });
});
