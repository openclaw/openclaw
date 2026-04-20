import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { setMediaStoreNetworkDepsForTest } from "../media/store.js";

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveOpenAiCompatibleHttpOperatorScopesMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveOpenAiCompatibleHttpOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopesMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
  readSessionMessages: readSessionMessagesMock,
}));

vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: getLatestSubagentRunByChildSessionKeyMock,
}));

const {
  DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
  handleManagedOutgoingImageHttpRequest,
  resolveManagedImageAttachmentLimits,
} = await import("./managed-image-attachments.js");

type RequestResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=";

async function createPngDataUrl(width: number, height: number): Promise<string> {
  const sharp = (await import("sharp")).default;
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 64, b: 128, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function createFixture(
  stateDir: string,
  options?: { sessionKey?: string; includeLegacyThumbnail?: boolean },
) {
  const attachmentId = "att-123";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const originalPath = path.join(stateDir, "files", "cat-full.png");
  const thumbnailPath = path.join(stateDir, "files", "cat-thumb.jpg");
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("original-image"));
  const record: Record<string, unknown> = {
    attachmentId,
    sessionKey,
    messageId: "msg-1",
    createdAt: new Date().toISOString(),
    alt: "Cat",
    original: {
      path: originalPath,
      contentType: "image/png",
      width: 1024,
      height: 768,
      sizeBytes: 14,
      filename: "cat.png",
    },
  };
  if (options?.includeLegacyThumbnail) {
    await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-image"));
    record.thumbnail = {
      path: thumbnailPath,
      contentType: "image/jpeg",
      width: 512,
      height: 384,
      sizeBytes: 15,
      filename: "cat-thumb.jpg",
    };
  }
  const recordsDir = path.join(stateDir, "media", "outgoing", "records");
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.writeFile(
    path.join(recordsDir, `${attachmentId}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return { attachmentId, sessionKey, originalPath, thumbnailPath };
}

async function requestManagedImage(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: Record<string, string>;
  transcriptMessages?: Record<string, unknown>[];
  subagentRun?: Record<string, unknown> | null;
}) {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return { ok: true, ...params.authResponse };
  });
  resolveOpenAiCompatibleHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(params.subagentRun ?? null);
  loadSessionEntryMock.mockReturnValue({
    storePath: path.join(params.stateDir, "gateway-sessions.json"),
    entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });
  readSessionMessagesMock.mockReturnValue(
    params.transcriptMessages ?? [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            url: params.pathName,
            openUrl: params.pathName,
          },
        ],
        __openclaw: { id: "msg-1" },
      },
    ],
  );

  const auth = { mode: "test" } as never;
  const server = http.createServer(async (req, res) => {
    const handled = await handleManagedOutgoingImageHttpRequest(req, res, {
      auth,
      trustedProxies: ["127.0.0.1/32"],
      allowRealIpFallback: false,
      stateDir: params.stateDir,
    });
    if (!handled) {
      res.statusCode = 404;
      res.end("unhandled");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await new Promise<RequestResult>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: params.pathName,
          method: params.method ?? "GET",
          headers: params.headers,
        },
        async (res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    return { result, auth };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("resolveManagedImageAttachmentLimits", () => {
  it("keeps the existing public limit shape", () => {
    expect(resolveManagedImageAttachmentLimits()).toEqual(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS);
  });
});

describe("handleManagedOutgoingImageHttpRequest", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-images-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    setMediaStoreNetworkDepsForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("serves full images for authorized chat-history readers", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("inline");
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("rejects unauthenticated requests before serving bytes", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      denyAuth: true,
    });

    expect(result.statusCode).toBe(401);
    expect(result.body.byteLength).toBe(0);
  });

  it("rejects requests from unrelated sessions", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": "agent:main:other" },
    });

    expect(result.statusCode).toBe(403);
  });

  it("allows device-token access without requester session ownership", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "device-token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("rejects non-GET methods", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      method: "POST",
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(405);
  });
});

describe("createManagedOutgoingImageBlocks", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-image-blocks-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    setMediaStoreNetworkDepsForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("creates inline/open blocks that both point at the full image", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
      messageId: "msg-1",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "image",
      alt: "Generated image 1",
      mimeType: "image/png",
    });
    expect(blocks[0]?.url).toBe(blocks[0]?.openUrl);
    expect(String(blocks[0]?.url)).toMatch(/\/full$/);
    expect(blocks[0]).not.toHaveProperty("downloadUrl");

    const recordsDir = path.join(stateDir, "media", "outgoing", "records");
    const [recordName] = await fs.readdir(recordsDir);
    const record = JSON.parse(await fs.readFile(path.join(recordsDir, recordName), "utf-8")) as {
      original: { path: string };
      thumbnail?: unknown;
    };
    expect(record.original.path).toContain(
      `${path.sep}media${path.sep}outgoing${path.sep}originals${path.sep}`,
    );
    expect(record.thumbnail).toBeUndefined();
  });

  it("rewrites local image sources into managed display blocks without leaking the source path", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const sourcePath = path.join(stateDir, "fixtures", "dot.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourcePath],
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("/api/chat/media/outgoing/agent%3Amain%3Amain/"),
        openUrl: expect.stringContaining("/full"),
      });
      expect(blocks[0]?.url).toBe(blocks[0]?.openUrl);
      expect(blocks[0]).not.toHaveProperty("downloadUrl");
      expect(JSON.stringify(blocks[0])).not.toContain(sourcePath);

      const attachmentId = String(blocks[0]?.url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      ) as { original: { filename: string; path: string }; thumbnail?: unknown };
      expect(record.original.filename).toMatch(/\.png$/);
      expect(record.original.path).not.toBe(sourcePath);
      expect(record.original.path).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      expect(record.thumbnail).toBeUndefined();
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("ingests external image URLs into managed storage instead of hotlinking them", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const imageBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/remote-cat.png?sig=secret");
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(imageBuffer);
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["127.0.0.1"],
        lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
      }),
    });

    try {
      const sourceUrl = `http://127.0.0.1:${address.port}/remote-cat.png?sig=secret`;
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.alt).toBe("remote-cat.png");
      expect(blocks[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("/api/chat/media/outgoing/agent%3Amain%3Amain/"),
        openUrl: expect.stringContaining("/full"),
      });
      expect(blocks[0]?.url).toBe(blocks[0]?.openUrl);
      expect(blocks[0]).not.toHaveProperty("downloadUrl");
      expect(JSON.stringify(blocks[0])).not.toContain("127.0.0.1");
      expect(JSON.stringify(blocks[0])).not.toContain("sig=secret");

      const attachmentId = String(blocks[0]?.url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      ) as { original: { path: string }; thumbnail?: unknown };
      expect(record.original.path).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      expect(record.thumbnail).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("127.0.0.1");
      expect(JSON.stringify(record)).not.toContain("sig=secret");
      expect(await fs.readFile(record.original.path)).toEqual(imageBuffer);
    } finally {
      setMediaStoreNetworkDepsForTest();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("merges configured managed image limits with defaults", () => {
    expect(resolveManagedImageAttachmentLimits()).toEqual(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS);
    expect(
      resolveManagedImageAttachmentLimits({
        maxWidth: 8192,
        thumbnailMaxDimension: 1024,
      }),
    ).toEqual({
      ...DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
      maxWidth: 8192,
      thumbnailMaxDimension: 1024,
      thumbnailMaxWidth: 1024,
      thumbnailMaxHeight: 1024,
    });
  });

  it("rejects managed outgoing images that exceed configured byte limits", async () => {
    await expect(
      createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
        limits: { maxBytes: 32 },
      }),
    ).rejects.toThrow(/0MB limit|32 bytes|byte limit/i);
  });

  it("adds a warning block when an image is resized to fit limits", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [await createPngDataUrl(200, 120)],
      stateDir,
      limits: { maxWidth: 64, maxHeight: 64, maxPixels: 4096 },
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[1]).toMatchObject({ type: "text" });
  });
});

describe("attachManagedOutgoingImagesToMessage", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-image-attach-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("upgrades transient image records to history when the message is committed", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });

    await attachManagedOutgoingImagesToMessage({
      messageId: "msg-committed",
      blocks: blocks as Record<string, unknown>[],
      stateDir,
    });

    const recordsDir = path.join(stateDir, "media", "outgoing", "records");
    const [recordName] = await fs.readdir(recordsDir);
    const record = JSON.parse(await fs.readFile(path.join(recordsDir, recordName), "utf-8")) as {
      messageId: string | null;
      retentionClass?: string;
      updatedAt?: string;
    };
    expect(record.messageId).toBe("msg-committed");
    expect(record.retentionClass).toBe("history");
    expect(typeof record.updatedAt).toBe("string");
  });
});

describe("cleanupManagedOutgoingImageRecords", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-image-cleanup-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("cleans up dereferenced records and legacy thumbnail files", async () => {
    const fixture = await createFixture(stateDir, { includeLegacyThumbnail: true });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result).toMatchObject({
      deletedRecordCount: 1,
      deletedFileCount: 2,
      retainedCount: 0,
    });
    await expect(fs.access(fixture.originalPath)).rejects.toThrow();
    await expect(fs.access(fixture.thumbnailPath)).rejects.toThrow();
  });

  it("retains committed records that are still referenced by a full-image block", async () => {
    const fixture = await createFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result).toMatchObject({
      deletedRecordCount: 0,
      deletedFileCount: 0,
      retainedCount: 1,
    });
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
  });
});
