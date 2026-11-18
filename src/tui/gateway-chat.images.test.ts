import { X509Certificate } from "node:crypto";
import http, { type RequestListener } from "node:http";
import https from "node:https";
import { afterAll, beforeAll, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import * as httpFixtures from "../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { GatewayClient } from "../gateway/client.js";
import { readImageMetadataFromHeader, resizeToJpeg } from "../media/image-ops.js";
import { GatewayChatClient } from "./gateway-chat.js";
import type { TuiImageData, TuiImageRequest } from "./tui-backend.js";
import { TUI_IMAGE_MAX_BYTES } from "./tui-image-data.js";

const sessionKey = "agent:main:images";
const attachmentId = "11111111-1111-4111-8111-111111111111";
const artifactId = `artifact_managed_image_${attachmentId}`;
const managedSource = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
const photo = "media://inbound/photo.jpg";
const artifact = { id: artifactId, type: "image", sessionKey, download: { mode: "url" } };

function expectPng(image: TuiImageData, width: number, height: number) {
  expect(image.mimeType).toBe("image/png");
  expect(readImageMetadataFromHeader(Buffer.from(image.data, "base64"))).toEqual({ width, height });
}

const requests: Array<[url: string | undefined, authorization: string | undefined, edge: string]> =
  [];
let handler: RequestListener;
const serve: RequestListener = (req, res) => {
  requests.push([req.url, req.headers.authorization, String(req.headers["x-image-proof"] ?? "")]);
  handler(req, res);
};
const server = http.createServer(serve);
const tlsServer = https.createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, serve);
let origin: string;
let tlsOrigin: string;
let jpeg: Buffer;
let requestSpy: MockInstance<GatewayClient["request"]>;
type Connection = Partial<ConstructorParameters<typeof GatewayChatClient>[0]>;
const load = (
  source = photo,
  options: Partial<TuiImageRequest> = {},
  connection: Connection = {},
) =>
  new GatewayChatClient({ url: origin, ...connection }).loadImage({
    sessionKey,
    source,
    signal: new AbortController().signal,
    ...options,
  });
const requestUrl = (index = 0) => new URL(requests[index]![0]!, "http://localhost");

beforeAll(async () => {
  requestSpy = vi.spyOn(GatewayClient.prototype, "request");
  origin = `${await httpFixtures.listenLoopback(server, "ws")}/gateway`;
  tlsOrigin = `${await httpFixtures.listenLoopback(tlsServer, "wss")}/gateway`;
  jpeg = await resizeToJpeg({
    buffer: createSolidPngBuffer(640, 320, { r: 24, g: 64, b: 128 }),
    maxSide: 640,
    quality: 80,
  });
});

beforeEach(() => {
  requests.length = 0;
  requestSpy.mockReset().mockResolvedValue({ runtimeConfig: {} });
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(jpeg);
  };
});

afterAll(async () => {
  requestSpy.mockRestore();
  for (const target of [server, tlsServer]) {
    await httpFixtures.closeHttpServer(target);
  }
});

it("loads inbound images from the connected subpath, authenticates, and emits a bounded PNG", async () => {
  handler = (req, res) => {
    if (req.headers.authorization !== "Bearer image-password") {
      res.writeHead(401).end();
    } else {
      res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
    }
  };
  const connection = {
    token: "stale-image-token",
    password: "image-password",
    edgeAuthHeaders: { "x-image-proof": "bound-edge-header" },
  };
  expectPng(await load(photo, { agentId: "main" }, connection), 300, 150);
  expect(requests.map(([, authorization]) => authorization)).toEqual([
    "Bearer stale-image-token",
    "Bearer image-password",
  ]);
  const url = requestUrl(1);
  expect(url.pathname).toBe("/gateway/__openclaw__/assistant-media");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    source: photo,
    sessionKey,
    agentId: "main",
  });
  expect(requests[1]?.[2]).toBe("bound-edge-header");
});

it("resolves a disabled Control UI media mount through the WebSocket path", async () => {
  requestSpy.mockResolvedValue({
    runtimeConfig: { gateway: { controlUi: { enabled: false, basePath: "console/" } } },
  });
  const url = origin.replace("/gateway", "/console");
  expect((await load(photo, {}, { url, token: "media-token" })).mimeType).toBe("image/png");
  expect(requests).toHaveLength(1);
  expect(requestUrl().pathname).toBe("/console/__openclaw__/assistant-media");
});

it("resolves generated images through the selected session and uses only the ticket for HTTP", async () => {
  requestSpy.mockResolvedValue({
    artifact,
    url: `${managedSource}?mediaTicket=synthetic-ticket`,
  });
  const result = await load(
    managedSource,
    { agentId: "main", artifactId },
    { token: "gateway-secret" },
  );
  expect(result.mimeType).toBe("image/png");
  expect(requestSpy.mock.calls[0]?.slice(0, 2)).toEqual([
    "artifacts.download",
    { sessionKey, agentId: "main", artifactId },
  ]);
  expect(requests).toEqual([
    [
      `/gateway${managedSource.replace(/\/full$/, "/thumbnail")}?mediaTicket=synthetic-ticket`,
      undefined,
      "",
    ],
  ]);
});

it("renders inline PNGs and rejects excessive header dimensions before decoding", async () => {
  const png = createSolidPngBuffer(4, 2, { r: 24, g: 64, b: 128 });
  const inline = (buffer: Buffer) => load(`data:image/png;base64,${buffer.toString("base64")}`);
  expectPng(await inline(png), 4, 2);
  const oversizedHeader = Buffer.from(png);
  oversizedHeader.writeUInt32BE(100_000, 16);
  oversizedHeader.writeUInt32BE(100_000, 20);
  await expect(inline(oversizedHeader)).rejects.toThrow("pixel limit");
  expect(requests).toHaveLength(0);
});

it.each([
  ["remote source", "https://remote.example/image.png", undefined],
  ["non-image data", "data:text/plain;base64,SGVsbG8=", undefined],
  ["cross-origin artifact", managedSource, `https://remote.example${managedSource}`],
  [
    "cross-session artifact",
    managedSource,
    managedSource.replace(encodeURIComponent(sessionKey), encodeURIComponent("agent:other:images")),
  ],
] as const)("rejects %s without an HTTP request", async (_, source, url) => {
  if (url) {
    requestSpy.mockResolvedValue({ artifact, url });
  }
  await expect(load(source)).rejects.toThrow(url ? "unavailable" : undefined);
  expect(requests).toHaveLength(0);
});

it.each([
  ["redirects", 302, { location: "/stolen-credentials" }, "302"],
  ["oversized response", 200, { "content-length": TUI_IMAGE_MAX_BYTES + 1 }, "byte limit"],
] as const)("rejects %s before consuming a response", async (_, code, headers, error) => {
  handler = (_req, res) => {
    res.writeHead(code, headers);
    res.flushHeaders();
  };
  await expect(load(photo, {}, { token: "gateway-secret" })).rejects.toThrow(error);
  expect(requests).toHaveLength(1);
});

it("honors cancellation before sending a request", async () => {
  await expect(load(photo, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

it("rejects chunked image overflow and closes the native response", async ({ signal }) => {
  const closed = createDeferred();
  handler = (_req, res) => {
    res.once("close", () => closed.resolve());
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.write(Buffer.alloc(TUI_IMAGE_MAX_BYTES + 1));
  };
  await expect(load()).rejects.toThrow("Image exceeds the preview byte limit");
  await withinTest(closed.promise, signal);
  expect(requests).toHaveLength(1);
});

it.each([
  [new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256, "tls-image-token", true],
  ["ab".repeat(32), "must-not-be-sent", false],
] as const)("verifies TLS pin %s before credentials", async (tlsFingerprint, token, valid) => {
  const result = load(photo, {}, { url: tlsOrigin, token, tlsFingerprint });
  if (valid) {
    expect((await result).mimeType).toBe("image/png");
  } else {
    await expect(result).rejects.toThrow("fingerprint mismatch");
  }
  expect(requests.map(([, authorization]) => authorization)).toEqual(
    valid ? ["Bearer tls-image-token"] : [],
  );
});
