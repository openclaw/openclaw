import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import {
  createFixture,
  prepareManagedSessionStore,
  usePreparedManagedImageState,
} from "./managed-image-attachments.test-support.js";
import { resolveManagedImageThumbnail } from "./managed-image-thumbnail-cache.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  authorize: vi.fn(),
  scopes: vi.fn(),
  owner: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: mocks.config }));
vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: mocks.authorize,
  resolveSharedSecretHttpOperatorScopes: mocks.scopes,
  resolveOpenAiCompatibleHttpSenderIsOwner: mocks.owner,
}));
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: vi.fn() }));
vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesMatchingIdAsync: mocks.transcript,
  readSessionMessagesWithSourceAsync: vi.fn(),
}));

const {
  cleanupManagedOutgoingMediaRecords,
  handleManagedOutgoingMediaHttpRequest,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} = await import("./managed-image-attachments.js");

describe("managed thumbnail conditional HTTP", () => {
  let stateDir: string;
  let origin: string;
  let server: http.Server;
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
      }).catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function request(pathName: string, method = "GET", tag?: string) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const req = http.request(
          `${origin}${pathName}`,
          { method, headers: tag === undefined ? {} : { "If-None-Match": tag }, agent: false },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
  }

  async function prepare(ticket = false) {
    const fixture = await createFixture(stateDir, {
      body: createSolidPngBuffer(16, 8, { r: 24, g: 64, b: 128 }),
    });
    const full = `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`;
    mocks.transcript.mockResolvedValue([
      { role: "assistant", content: [{ type: "image", url: full }], __openclaw: { id: "msg-1" } },
    ]);
    const download = ticket
      ? await resolveManagedOutgoingMediaArtifactDownload({
          sessionKey: fixture.sessionKey,
          artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${fixture.attachmentId}`,
          stateDir,
        })
      : undefined;
    if (ticket && !download) {
      throw new Error("Missing fixture artifact ticket");
    }
    return { ...fixture, url: (download?.url ?? full).replace(/\/full(?=\?|$)/, "/thumbnail") };
  }

  it.each([false, true])("revalidates final thumbnail bytes for ticket=%s", async (ticket) => {
    const fixture = await prepare(ticket);
    const first = await request(fixture.url);
    expect(first.status).toBe(200);
    const etag = `"${createHash("sha256").update(first.body).digest("base64url")}"`;
    expect(first.headers.etag).toBe(etag);
    expect(first.headers["cache-control"]).toBe(
      ticket ? "private, max-age=300, immutable" : "private, max-age=31536000, immutable",
    );
    expect(first.headers["content-disposition"]).toContain("cat-thumbnail.png");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
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
    expect(changed.headers.etag).toBe(
      `"${createHash("sha256").update(changed.body).digest("base64url")}"`,
    );
  });

  it("does not expose validators for invalid tickets or denied owners", async () => {
    const fixture = await prepare();
    mocks.authorize.mockImplementation(async ({ res }) => {
      res.statusCode = 401;
      res.end();
      return null;
    });
    const invalid = await request(`${fixture.url}?mediaTicket=invalid`, "GET", "*");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.etag).toBeUndefined();
    mocks.authorize.mockImplementation(async ({ res }) =>
      bindHttpResponseAuthority({ authMethod: "device-token" }, res, () => true),
    );
    mocks.owner.mockReturnValue(false);
    const denied = await request(fixture.url, "GET", "*");
    expect(denied.status).toBe(403);
    expect(denied.headers.etag).toBeUndefined();
  });

  it("reauthorizes the transcript before a ticketed conditional response", async () => {
    const fixture = await prepare(true);
    mocks.transcript.mockResolvedValue([]);
    const missing = await request(fixture.url, "GET", "*");
    expect(missing.status).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
  });
});
