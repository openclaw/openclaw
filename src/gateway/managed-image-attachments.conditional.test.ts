import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { readImageProbeFromHeader } from "../media/image-ops.js";
import {
  clearArtifactDownloads,
  createManagedArtifactDownload,
} from "./artifact-download-grants.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import {
  createFixture,
  prepareManagedSessionStore,
  usePreparedManagedImageState,
} from "./managed-image-attachments.test-support.js";
import { resolveManagedImageThumbnail } from "./managed-image-thumbnail-cache.js";
import { createSessionFileDownloadClient } from "./server-methods/sessions-files.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  authorize: vi.fn(),
  scopes: vi.fn(),
  owner: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: mocks.config,
}));
vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeGatewayHttpRequestOrReply: mocks.authorize,
  resolveSharedSecretHttpOperatorScopes: mocks.scopes,
  resolveOpenAiCompatibleHttpSenderIsOwner: mocks.owner,
}));
vi.mock("./session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-readers.js")>()),
  readSessionMessagesMatchingIdAsync: mocks.transcript,
  readSessionMessagesWithSourceAsync: vi.fn(),
}));

const {
  cleanupManagedOutgoingMediaRecords,
  handleManagedOutgoingMediaHttpRequest,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} = await import("./managed-image-attachments.js");

const etagFor = (body: Buffer) => `"${createHash("sha256").update(body).digest("base64url")}"`;
const png = (width = 16, height = 8) =>
  createSolidPngBuffer(width, height, { r: 24, g: 64, b: 128 });
function expectThumbnail(result: { status: number; body: Buffer }, width: number, height: number) {
  expect(result.status).toBe(200);
  expect(readImageProbeFromHeader(result.body)).toMatchObject({ format: "webp", width, height });
}

describe("managed thumbnail conditional HTTP", () => {
  let stateDir: string;
  let origin: string;
  let server: http.Server;
  const clients = new Set<GatewayClient>();
  usePreparedManagedImageState({
    prefix: "managed-thumbnail-conditional-",
    bindState: (prepared) => {
      stateDir = prepared;
    },
    prepareSessionStore: async (prepared) => {
      await prepareManagedSessionStore(prepared);
    },
    cleanupRecords: cleanupManagedOutgoingMediaRecords,
    resetMocks: (prepared) => {
      vi.clearAllMocks();
      clients.clear();
      mocks.config.mockReturnValue({ session: { store: path.join(prepared, "sessions.sqlite") } });
      mocks.authorize.mockImplementation(async ({ res }) =>
        bindHttpResponseAuthority({ authMethod: "token" }, res, () => true),
      );
      mocks.scopes.mockReturnValue(["operator.read"]);
      mocks.owner.mockReturnValue(true);
    },
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void handleManagedOutgoingMediaHttpRequest(req, res, {
        auth: { mode: "none", allowTailscale: false },
        stateDir,
        clients,
      }).catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
    origin = await listenLoopback(server);
  });
  afterEach(() => clearArtifactDownloads());
  afterAll(() => closeHttpServer(server));

  async function request(pathName: string, method = "GET", tag?: string) {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          `${origin}${pathName}`,
          {
            method,
            headers: tag === undefined ? {} : { "If-None-Match": tag },
            agent: false,
          },
          resolve,
        )
        .on("error", reject);
    });
    return {
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: await buffer(response),
    };
  }

  async function prepare(client?: GatewayClient, body = png()) {
    const fixture = await createFixture(stateDir, { body });
    const full = `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`;
    mocks.transcript.mockResolvedValue([
      { role: "assistant", content: [{ type: "image", url: full }], __openclaw: { id: "msg-1" } },
    ]);
    let url = full;
    if (client) {
      const source = await resolveManagedOutgoingMediaArtifactDownload({
        sessionKey: fixture.sessionKey,
        artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${fixture.attachmentId}`,
        stateDir,
      });
      const download =
        source &&
        createManagedArtifactDownload({
          client,
          path: source.url,
          assertCurrent() {},
          release() {},
        });
      if (!download) {
        throw new Error("Missing fixture artifact ticket");
      }
      url = download.url;
      clients.add(client);
    }
    return { ...fixture, url: url.replace(/\/full(?=\?|$)/, "/thumbnail") };
  }

  it.each([false, true])("revalidates final thumbnail bytes for ticket=%s", async (ticket) => {
    using connection = ticket ? createSessionFileDownloadClient() : null;
    const fixture = await prepare(connection?.client);
    const first = await request(fixture.url);
    expectThumbnail(first, 16, 8);
    const etag = etagFor(first.body);
    expect(first.headers).toMatchObject({
      "content-type": "image/webp",
      etag,
      "cache-control": ticket ? "private, no-store" : "private, max-age=31536000, immutable",
      "content-disposition": expect.stringContaining("cat-thumbnail.webp"),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    const head = await request(fixture.url, "HEAD");
    expect(head.headers.etag).toBe(etag);
    expect(head.headers["content-length"]).toBe(String(first.body.byteLength));
    expect(head.body).toHaveLength(0);
    for (const method of ["GET", "HEAD"]) {
      const unchanged = await request(fixture.url, method, `"other", W/${etag}`);
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.etag).toBe(etag);
      expect(unchanged.headers["cache-control"]).toBe(first.headers["cache-control"]);
      expect(unchanged.body).toHaveLength(0);
      expect(unchanged.headers["content-length"]).toBeUndefined();
    }
    const stale = await request(fixture.url, "GET", '"stale"');
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(first.body);
  });

  it("revalidates the selected rendition without reusing another width's validator", async () => {
    const fixture = await prepare(undefined, png(1600, 800));
    const normal = await request(fixture.url);
    expectThumbnail(normal, 960, 480);
    const smallUrl = `${fixture.url}?width=480`;
    const small = await request(smallUrl, "GET", normal.headers.etag);
    expectThumbnail(small, 480, 240);
    expect(small.headers.etag).toBe(etagFor(small.body));
    expect(small.headers.etag).not.toBe(normal.headers.etag);
    const unchanged = await request(smallUrl, "GET", small.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toHaveLength(0);
    const defaultWidth = await request(`${fixture.url}?width=960`, "HEAD", normal.headers.etag);
    expect(defaultWidth.status).toBe(304);
    expect(defaultWidth.body).toHaveLength(0);
  });

  it("keeps validators byte-stable across eviction and changes them with the rendition", async () => {
    const fixture = await prepare();
    const first = await request(fixture.url);
    expect(first.headers.etag).toBeTypeOf("string");
    for (let index = 0; index < 129; index++) {
      await resolveManagedImageThumbnail(`conditional-eviction-${index}`, async () =>
        Buffer.alloc(1),
      );
    }
    const regenerated = await request(fixture.url);
    expect(regenerated.body).toEqual(first.body);
    expect(regenerated.headers.etag).toBe(first.headers.etag);
    await fs.writeFile(fixture.originalPath, createSolidPngBuffer(16, 8, { r: 128, g: 64, b: 24 }));
    const modified = new Date(Date.now() + 2_000);
    await fs.utimes(fixture.originalPath, modified, modified);
    const changed = await request(fixture.url, "GET", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.body).not.toEqual(first.body);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(changed.headers.etag).toBe(etagFor(changed.body));
  });

  it("does not expose validators for invalid tickets or denied owners", async () => {
    const fixture = await prepare();
    mocks.authorize.mockImplementation(async ({ res }) => {
      res.statusCode = 401;
      res.end();
      return null;
    });
    const invalid = await request(`${fixture.url}?mediaTicket=invalid`, "GET", "*");
    expect(invalid.status).toBe(404);
    expect(invalid.headers.etag).toBeUndefined();
    expect(mocks.authorize).not.toHaveBeenCalled();
    mocks.authorize.mockImplementation(async ({ res }) =>
      bindHttpResponseAuthority({ authMethod: "device-token" }, res, () => true),
    );
    mocks.owner.mockReturnValue(false);
    const denied = await request(fixture.url, "GET", "*");
    expect(denied.status).toBe(403);
    expect(denied.headers.etag).toBeUndefined();
  });

  it("reauthorizes the transcript before a ticketed conditional response", async () => {
    using connection = createSessionFileDownloadClient();
    const fixture = await prepare(connection.client);
    mocks.transcript.mockResolvedValue([]);
    const missing = await request(fixture.url, "GET", "*");
    expect(missing.status).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
  });
});
