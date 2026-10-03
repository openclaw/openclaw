import { X509Certificate } from "node:crypto";
import http, { type RequestListener } from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { GatewayClient } from "../gateway/client.js";
import { readImageMetadataFromHeader, resizeToJpeg } from "../media/image-ops.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { TUI_IMAGE_MAX_BYTES } from "./tui-image-data.js";

const sessionKey = "agent:main:images";
const attachmentId = "11111111-1111-4111-8111-111111111111";
const artifactId = `artifact_managed_image_${attachmentId}`;
const managedSource = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
const request = (source: string) => ({ sessionKey, source, signal: new AbortController().signal });

describe("GatewayChatClient image previews", () => {
  const requests: Array<{ url?: string; authorization?: string; edge?: string }> = [];
  let handler: RequestListener;
  const serve: RequestListener = (req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      edge: String(req.headers["x-image-proof"] ?? ""),
    });
    handler(req, res);
  };
  const server = http.createServer(serve);
  const tlsServer = https.createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, serve);
  let origin: string;
  let tlsOrigin: string;
  let jpeg: Buffer;

  beforeAll(async () => {
    const listen = async (target: http.Server) => {
      await new Promise<void>((resolve) => {
        target.listen(0, "127.0.0.1", resolve);
      });
      const address = target.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing test server address");
      }
      return `127.0.0.1:${address.port}`;
    };
    origin = `ws://${await listen(server)}/gateway`;
    tlsOrigin = `wss://${await listen(tlsServer)}/gateway`;
    jpeg = await resizeToJpeg({
      buffer: createSolidPngBuffer(640, 320, { r: 24, g: 64, b: 128 }),
      maxSide: 640,
      quality: 80,
    });
  });

  beforeEach(() => {
    requests.length = 0;
    vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({ runtimeConfig: {} });
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    };
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const target of [server, tlsServer]) {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        target.close((error) => (error ? reject(error) : resolve()));
      });
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
    const client = new GatewayChatClient({
      url: origin,
      token: "stale-image-token",
      password: "image-password",
      edgeAuthHeaders: { "x-image-proof": "bound-edge-header" },
    });
    const result = await client.loadImage({
      ...request("media://inbound/photo.jpg"),
      agentId: "main",
    });
    expect(result.mimeType).toBe("image/png");
    expect(readImageMetadataFromHeader(Buffer.from(result.data, "base64"))).toEqual({
      width: 300,
      height: 150,
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((entry) => entry.authorization)).toEqual([
      "Bearer stale-image-token",
      "Bearer image-password",
    ]);
    const url = new URL(requests[1]!.url!, "http://localhost");
    expect(url.pathname).toBe("/gateway/__openclaw__/assistant-media");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "media://inbound/photo.jpg",
      sessionKey,
      agentId: "main",
    });
    expect(requests[1]?.edge).toBe("bound-edge-header");
  });

  it.each([
    { wsPath: "/", basePath: "/console", expectedBase: "/console" },
    { wsPath: "/console", basePath: "console/", expectedBase: "/console" },
    { wsPath: "/proxy", basePath: "/console", expectedBase: "/proxy/console" },
    { wsPath: "/proxy/console/", basePath: "/console", expectedBase: "/proxy/console" },
    { wsPath: "/proxy", basePath: "", expectedBase: "/proxy" },
  ])(
    "resolves media mount $basePath through WebSocket path $wsPath",
    async ({ wsPath, basePath, expectedBase }) => {
      const rpc = vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({
        runtimeConfig: { gateway: { controlUi: { enabled: false, basePath } } },
      });
      const gatewayUrl = new URL(origin);
      gatewayUrl.pathname = wsPath;
      const client = new GatewayChatClient({ url: gatewayUrl.href, token: "media-token" });
      expect((await client.loadImage(request("media://inbound/photo.jpg"))).mimeType).toBe(
        "image/png",
      );
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        "config.get",
        {},
        { signal: expect.any(AbortSignal) },
      );
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url!, "http://localhost").pathname).toBe(
        `${expectedBase}/__openclaw__/assistant-media`,
      );
    },
  );

  it("does not guess an image mount when the config owner fails", async () => {
    vi.spyOn(GatewayClient.prototype, "request").mockRejectedValue(new Error("config unavailable"));
    const client = new GatewayChatClient({ url: origin, token: "media-token" });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "config unavailable",
    );
    expect(requests).toHaveLength(0);
  });

  it("resolves generated images through the selected session and uses only the ticket for HTTP", async () => {
    const rpc = vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({
      artifact: { id: artifactId, type: "image", sessionKey, download: { mode: "url" } },
      url: `${managedSource}?mediaTicket=synthetic-ticket`,
    });
    const client = new GatewayChatClient({ url: origin, token: "gateway-secret" });
    const result = await client.loadImage({
      ...request(managedSource),
      agentId: "main",
      artifactId,
    });
    expect(result.mimeType).toBe("image/png");
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "artifacts.download",
      { sessionKey, agentId: "main", artifactId },
      { signal: expect.any(AbortSignal) },
    );
    expect(requests).toEqual([
      {
        url: `/gateway${managedSource.replace(/\/full$/, "/thumbnail")}?mediaTicket=synthetic-ticket`,
        authorization: undefined,
        edge: "",
      },
    ]);
  });

  it("never follows a redirect carrying Gateway credentials", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "/stolen-credentials" }).end();
    const client = new GatewayChatClient({ url: origin, token: "gateway-secret" });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow("302");
    expect(requests).toHaveLength(1);
  });

  it("renders inline PNGs and rejects excessive header dimensions before decoding", async () => {
    const client = new GatewayChatClient({ url: origin });
    const png = createSolidPngBuffer(4, 2, { r: 24, g: 64, b: 128 });
    const inlineRequest = (buffer: Buffer) =>
      request(`data:image/png;base64,${buffer.toString("base64")}`);
    const image = await client.loadImage(inlineRequest(png));
    expect(image.mimeType).toBe("image/png");
    expect(readImageMetadataFromHeader(Buffer.from(image.data, "base64"))).toEqual({
      width: 4,
      height: 2,
    });
    const oversizedHeader = Buffer.from(png);
    oversizedHeader.writeUInt32BE(100_000, 16);
    oversizedHeader.writeUInt32BE(100_000, 20);
    await expect(client.loadImage(inlineRequest(oversizedHeader))).rejects.toThrow("pixel limit");
    expect(requests).toHaveLength(0);
  });

  it.each([
    "https://remote.example/image.png",
    "//remote.example/image.png",
    "file:///tmp/image.png",
    "media://inbound/nested%2Fphoto.png",
    "data:text/plain;base64,SGVsbG8=",
  ])("rejects unsupported source %s without making a request", async (source) => {
    const client = new GatewayChatClient({ url: origin });
    await expect(client.loadImage(request(source))).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("rejects artifact responses that cross session or origin boundaries", async () => {
    const rpc = vi.spyOn(GatewayClient.prototype, "request");
    const client = new GatewayChatClient({ url: origin });
    for (const url of [
      `https://remote.example${managedSource}`,
      managedSource.replace(
        encodeURIComponent(sessionKey),
        encodeURIComponent("agent:other:images"),
      ),
    ]) {
      rpc.mockResolvedValue({
        artifact: { id: artifactId, type: "image", sessionKey, download: { mode: "url" } },
        url,
      });
      await expect(client.loadImage(request(managedSource))).rejects.toThrow("unavailable");
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects oversized images before reading the response body and honors cancellation", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": TUI_IMAGE_MAX_BYTES + 1 });
      res.flushHeaders();
    };
    const client = new GatewayChatClient({ url: origin });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "byte limit",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.loadImage({ ...request("media://inbound/photo.jpg"), signal: controller.signal }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("verifies pinned TLS before sending credentials", async () => {
    const valid = new GatewayChatClient({
      url: tlsOrigin,
      token: "tls-image-token",
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    });
    expect((await valid.loadImage(request("media://inbound/photo.jpg"))).mimeType).toBe(
      "image/png",
    );
    expect(requests[0]?.authorization).toBe("Bearer tls-image-token");
    const invalid = new GatewayChatClient({
      url: tlsOrigin,
      token: "must-not-be-sent",
      tlsFingerprint: "ab".repeat(32),
    });
    await expect(invalid.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "fingerprint mismatch",
    );
    expect(requests).toHaveLength(1);
  });
});
