import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { setMediaStoreNetworkDepsForTest } from "../media/store.js";
import { DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_HEIGHT } from "../shared/managed-image-thumbnail-limits.js";

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveTrustedHttpOperatorScopesMock = vi.fn();
const resolveOpenAiCompatibleHttpOperatorScopesMock = vi.fn();
const resolveSubagentControllerMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveTrustedHttpOperatorScopes: resolveTrustedHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopesMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
  readSessionMessages: readSessionMessagesMock,
}));

vi.mock("../agents/subagent-control.js", () => ({
  resolveSubagentController: resolveSubagentControllerMock,
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

async function createFixture(stateDir: string, options?: { sessionKey?: string }) {
  const attachmentId = "att-123";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const originalPath = path.join(stateDir, "files", "cat-full.png");
  const thumbnailPath = path.join(stateDir, "files", "cat-thumb.jpg");
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("original-image"));
  await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-image"));
  const recordsDir = path.join(stateDir, "media", "outgoing", "records");
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.writeFile(
    path.join(recordsDir, `${attachmentId}.json`),
    JSON.stringify(
      {
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
        thumbnail: {
          path: thumbnailPath,
          contentType: "image/jpeg",
          width: 512,
          height: 384,
          sizeBytes: 15,
          filename: "cat-thumb.jpg",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { attachmentId, sessionKey, originalPath, thumbnailPath };
}

async function requestManagedImage(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  compatibleScopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: Record<string, string>;
  transcriptMessages?: Record<string, unknown>[];
  subagentRun?: Record<string, unknown> | null;
  subagentController?: Record<string, unknown> | null;
}) {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return { ok: true, ...params.authResponse };
  });
  resolveTrustedHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  resolveOpenAiCompatibleHttpOperatorScopesMock.mockReturnValue(
    params.compatibleScopes ?? params.scopes ?? ["operator.read"],
  );
  getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(params.subagentRun ?? null);
  resolveSubagentControllerMock.mockResolvedValue(params.subagentController ?? null);
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
            url: params.pathName.replace(/\/(full|download)$/, "/thumb"),
            openUrl: params.pathName.replace(/\/(thumb|download)$/, "/full"),
            downloadUrl: params.pathName.replace(/\/(thumb|full)$/, "/download"),
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
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }

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

  it("serves thumbnails for authorized chat-history readers", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result, auth } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/jpeg");
    expect(result.headers["content-disposition"]).toContain("inline");
    expect(result.body.toString("utf-8")).toBe("thumbnail-image");
    expect(authorizeGatewayHttpRequestOrReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auth,
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: false,
      }),
    );
  });

  it("rejects unauthenticated requests before serving any attachment bytes", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      denyAuth: true,
    });

    expect(result.statusCode).toBe(401);
    expect(result.body.length).toBe(0);
  });

  it("rejects shared-secret attachment fetches without requester session ownership proof", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.toString("utf-8")).toContain("requester session ownership required");
  });

  it("allows shared-secret browser auth when requester ownership proof is present", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      scopes: [],
      compatibleScopes: ["operator.read"],
      authResponse: {
        authMethod: "password",
        trustDeclaredOperatorScopes: false,
      },
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.body.toString("utf-8")).toBe("original-image");
    expect(resolveOpenAiCompatibleHttpOperatorScopesMock).toHaveBeenCalled();
  });

  it("rejects shared-secret attachment fetches for a different requester session", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": "agent:other:main" },
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.toString("utf-8")).toContain("does not own attachment session");
  });

  it.each(["thumb", "full", "download"])(
    "rejects %s requests without chat.history scope",
    async (variant) => {
      const { attachmentId, sessionKey } = await createFixture(stateDir);

      const { result } = await requestManagedImage({
        stateDir,
        pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/${variant}`,
        scopes: [],
        headers: { "x-openclaw-requester-session-key": sessionKey },
      });

      expect(result.statusCode).toBe(403);
      expect(result.headers["content-type"]).toContain("application/json");
      expect(result.body.toString("utf-8")).toContain("missing scope: operator.read");
    },
  );

  it("serves full-size originals inline for authorized viewers", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("inline");
    expect(result.headers["content-disposition"]).toContain('filename="cat.png"');
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("serves original files as attachments for download requests", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/download`,
      scopes: ["operator.write"],
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("attachment");
    expect(result.headers["content-disposition"]).toContain('filename="cat.png"');
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("rejects attachment fetches that are not tied to the stored transcript message", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": sessionKey },
      transcriptMessages: [
        {
          role: "assistant",
          content: [
            { type: "image", url: "/api/chat/media/outgoing/agent%3Amain%3Amain/other/thumb" },
          ],
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(result.statusCode).toBe(404);
  });

  it("rejects attachment fetches when the path session key does not match the record owner", async () => {
    const { attachmentId } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent("agent:other:main")}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": "agent:other:main" },
    });

    expect(result.statusCode).toBe(404);
  });

  it("allows a parent controller session to fetch a subagent attachment", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      sessionKey: "agent:child:session",
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      headers: { "x-openclaw-requester-session-key": "agent:main:controller" },
      subagentRun: {
        id: "run-1",
        childSessionKey: sessionKey,
        requesterSessionKey: "agent:main:controller",
        controllerSessionKey: "agent:main:controller",
      },
      subagentController: { sessionKey: "agent:main:controller" },
    });

    expect(result.statusCode).toBe(200);
  });

  it("does not require requester-session ownership for device-token attachment fetches", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      scopes: ["operator.read"],
      authResponse: { authMethod: "device-token" },
    });

    expect(result.statusCode).toBe(200);
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
        downloadUrl: expect.stringContaining("/download"),
      });
      expect(JSON.stringify(blocks[0])).not.toContain(sourcePath);

      const firstBlock = blocks[0];
      expect(firstBlock).toBeTruthy();
      if (!firstBlock) {
        throw new Error("missing managed image block");
      }
      const attachmentId = firstBlock.url.split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      if (!attachmentId) {
        throw new Error("missing attachment id");
      }
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(record.original.filename).toMatch(/\.png$/);
      expect(record.original.path).not.toBe(sourcePath);
      expect(record.original.path).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      expect(record.thumbnail.path).toContain(path.join(stateDir, "media", "outgoing", "thumbs"));
      expect(record.messageId).toBeNull();
      expect(record.retentionClass).toBe("transient");

      await attachManagedOutgoingImagesToMessage({
        stateDir,
        messageId: "msg-bound",
        blocks,
      });

      const reboundRecord = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(reboundRecord.messageId).toBe("msg-bound");
      expect(reboundRecord.retentionClass).toBe("history");
      expect(typeof reboundRecord.updatedAt).toBe("string");
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
      expect(blocks[0].alt).toBe("remote-cat.png");
      expect(blocks[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("/api/chat/media/outgoing/agent%3Amain%3Amain/"),
        openUrl: expect.stringContaining("/full"),
        downloadUrl: expect.stringContaining("/download"),
      });
      expect(JSON.stringify(blocks[0])).not.toContain("127.0.0.1");
      expect(JSON.stringify(blocks[0])).not.toContain("sig=secret");

      const firstBlock = blocks[0];
      expect(firstBlock).toBeTruthy();
      if (!firstBlock) {
        throw new Error("missing managed image block");
      }
      const attachmentId = firstBlock.url.split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      if (!attachmentId) {
        throw new Error("missing attachment id");
      }
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(record.original.path).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      expect(record.thumbnail.path).toContain(path.join(stateDir, "media", "outgoing", "thumbs"));
      expect(JSON.stringify(record)).not.toContain("127.0.0.1");
      expect(JSON.stringify(record)).not.toContain("sig=secret");
      expect(await fs.readFile(record.original.path)).toEqual(imageBuffer);
    } finally {
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

  it("normalizes base64 image data URLs into managed storage without leaking the payload", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].alt).toBe("Generated image 1");
      expect(blocks[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("/api/chat/media/outgoing/agent%3Amain%3Amain/"),
        openUrl: expect.stringContaining("/full"),
        downloadUrl: expect.stringContaining("/download"),
      });
      expect(JSON.stringify(blocks[0])).not.toContain("data:image/png;base64");
      expect(JSON.stringify(blocks[0])).not.toContain(TINY_PNG_BASE64);

      const firstBlock = blocks[0];
      expect(firstBlock).toBeTruthy();
      if (!firstBlock) {
        throw new Error("missing managed image block");
      }
      const attachmentId = firstBlock.url.split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      if (!attachmentId) {
        throw new Error("missing attachment id");
      }
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(record.original.path).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      expect(record.thumbnail.path).toContain(path.join(stateDir, "media", "outgoing", "thumbs"));
      expect(JSON.stringify(record)).not.toContain("data:image/png;base64");
      expect(JSON.stringify(record)).not.toContain(TINY_PNG_BASE64);
      expect(await fs.readFile(record.original.path)).toEqual(
        Buffer.from(TINY_PNG_BASE64, "base64"),
      );
      expect(record.thumbnail.contentType).toBe("image/png");
      expect(record.thumbnail.width).toBe(1);
      expect(record.thumbnail.height).toBe(1);
      expect(await fs.readFile(record.thumbnail.path)).toEqual(
        Buffer.from(TINY_PNG_BASE64, "base64"),
      );
    } finally {
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
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      await expect(
        createManagedOutgoingImageBlocks({
          stateDir,
          sessionKey: "agent:main:main",
          mediaUrls: [sourceUrl],
          limits: { maxBytes: 32 },
        }),
      ).rejects.toThrow(/0MB limit|32 bytes|byte limit/i);
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("resizes managed outgoing images that exceed configured dimension limits and adds a warning block", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = await createPngDataUrl(5000, 4000);
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
        limits: { maxWidth: 4096 },
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({ type: "image", alt: "Generated image 1" });
      expect(blocks[1]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/resized from 5000×4000 to 409[56]×3276/i),
      });

      const attachmentId = String(blocks[0].url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(record.original.width).toBeLessThanOrEqual(4096);
      expect(record.original.height).toBe(3276);
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("keeps small originals as 1:1 thumbnail copies instead of re-encoding them", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = await createPngDataUrl(300, 200);
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        width: 300,
        height: 200,
      });

      const attachmentId = String(blocks[0].url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );

      expect(record.original.contentType).toBe("image/png");
      expect(record.thumbnail.contentType).toBe("image/png");
      expect(record.original.width).toBe(300);
      expect(record.original.height).toBe(200);
      expect(record.thumbnail.width).toBe(300);
      expect(record.thumbnail.height).toBe(200);
      expect(await fs.readFile(record.thumbnail.path)).toEqual(
        await fs.readFile(record.original.path),
      );
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("defaults thumbnail resizing to the shared inline thumbnail bounds", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = await createPngDataUrl(1200, 1600);
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
      });

      expect(blocks).toHaveLength(1);
      const attachmentId = String(blocks[0].url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );

      expect(record.original.width).toBe(1200);
      expect(record.original.height).toBe(1600);
      expect(record.thumbnail.width).toBe(
        Math.round((1200 / 1600) * DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_HEIGHT),
      );
      expect(record.thumbnail.height).toBe(DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_HEIGHT);
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("resizes managed outgoing images that exceed configured pixel limits", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sourceUrl = await createPngDataUrl(2000, 2000);
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourceUrl],
        limits: { maxPixels: 1_000_000 },
      });

      expect(blocks).toHaveLength(2);
      const attachmentId = String(blocks[0].url).split("/").at(-2);
      expect(attachmentId).toBeTruthy();
      const record = JSON.parse(
        await fs.readFile(
          path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`),
          "utf-8",
        ),
      );
      expect(record.original.width * record.original.height).toBeLessThanOrEqual(1_000_000);
      expect(blocks[1]).toMatchObject({
        type: "text",
        text: expect.stringContaining("exceeded gateway dimension/pixel limits"),
      });
    } finally {
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("cleans up stale transient managed-image records and files", async () => {
    const fixture = await createFixture(stateDir);
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      `${fixture.attachmentId}.json`,
    );
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        attachmentId: fixture.attachmentId,
        sessionKey: "agent:main:main",
        messageId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        alt: "stale image",
        original: {
          path: fixture.originalPath,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.originalPath),
        },
        thumbnail: {
          path: fixture.thumbnailPath,
          contentType: "image/jpeg",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.thumbnailPath),
        },
      }),
      "utf-8",
    );

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: Date.parse("2026-01-01T00:30:00.000Z"),
      transientMaxAgeMs: 60_000,
    });

    expect(result).toMatchObject({
      deletedRecordCount: 1,
      deletedFileCount: 2,
      retainedCount: 0,
    });
    await expect(fs.access(recordPath)).rejects.toThrow();
    await expect(fs.access(fixture.originalPath)).rejects.toThrow();
    await expect(fs.access(fixture.thumbnailPath)).rejects.toThrow();
  });

  it("cleans up dereferenced bound managed-image records and files", async () => {
    const fixture = await createFixture(stateDir);
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      `${fixture.attachmentId}.json`,
    );
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        attachmentId: fixture.attachmentId,
        sessionKey: "agent:main:main",
        messageId: "msg-missing",
        createdAt: new Date().toISOString(),
        alt: "bound image",
        original: {
          path: fixture.originalPath,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.originalPath),
        },
        thumbnail: {
          path: fixture.thumbnailPath,
          contentType: "image/jpeg",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.thumbnailPath),
        },
      }),
      "utf-8",
    );
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
    await expect(fs.access(recordPath)).rejects.toThrow();
    await expect(fs.access(fixture.originalPath)).rejects.toThrow();
    await expect(fs.access(fixture.thumbnailPath)).rejects.toThrow();
  });

  it("retains committed managed-image records that are still referenced", async () => {
    const fixture = await createFixture(stateDir);
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      `${fixture.attachmentId}.json`,
    );
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        attachmentId: fixture.attachmentId,
        sessionKey: "agent:main:main",
        messageId: "msg-keep",
        createdAt: new Date().toISOString(),
        alt: "committed image",
        original: {
          path: fixture.originalPath,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.originalPath),
        },
        thumbnail: {
          path: fixture.thumbnailPath,
          contentType: "image/jpeg",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.thumbnailPath),
        },
      }),
      "utf-8",
    );
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-keep" },
        content: [
          {
            type: "image",
            url: `http://127.0.0.1:8080/api/chat/media/outgoing/agent%3Amain%3Amain/${fixture.attachmentId}/thumb`,
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
    await expect(fs.access(recordPath)).resolves.toBeUndefined();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    await expect(fs.access(fixture.thumbnailPath)).resolves.toBeUndefined();
  });

  it("cleans up orphan managed-image files even without records", async () => {
    const orphanOriginalPath = path.join(stateDir, "media", "outgoing", "originals", "orphan.png");
    const orphanThumbnailPath = path.join(stateDir, "media", "outgoing", "thumbs", "orphan.jpg");
    await fs.mkdir(path.dirname(orphanOriginalPath), { recursive: true });
    await fs.mkdir(path.dirname(orphanThumbnailPath), { recursive: true });
    await fs.writeFile(orphanOriginalPath, Buffer.from("orphan-original"));
    await fs.writeFile(orphanThumbnailPath, Buffer.from("orphan-thumb"));

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result).toMatchObject({
      deletedRecordCount: 0,
      deletedFileCount: 2,
      retainedCount: 0,
    });
    await expect(fs.access(orphanOriginalPath)).rejects.toThrow();
    await expect(fs.access(orphanThumbnailPath)).rejects.toThrow();
  });

  it("force-deletes managed-image records for a deleted session", async () => {
    const fixture = await createFixture(stateDir);
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      `${fixture.attachmentId}.json`,
    );
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        attachmentId: fixture.attachmentId,
        sessionKey: "agent:main:main",
        messageId: null,
        createdAt: new Date().toISOString(),
        alt: "transient image",
        original: {
          path: fixture.originalPath,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.originalPath),
        },
        thumbnail: {
          path: fixture.thumbnailPath,
          contentType: "image/jpeg",
          width: 1,
          height: 1,
          sizeBytes: 68,
          filename: path.basename(fixture.thumbnailPath),
        },
      }),
      "utf-8",
    );

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "agent:main:main",
      forceDeleteSessionRecords: true,
    });

    expect(result).toMatchObject({
      deletedRecordCount: 1,
      deletedFileCount: 2,
      retainedCount: 0,
    });
    await expect(fs.access(recordPath)).rejects.toThrow();
    await expect(fs.access(fixture.originalPath)).rejects.toThrow();
    await expect(fs.access(fixture.thumbnailPath)).rejects.toThrow();
  });

  it("rejects non-GET methods", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/thumb`,
      method: "POST",
      scopes: ["operator.read"],
    });

    expect(result.statusCode).toBe(405);
    expect(authorizeGatewayHttpRequestOrReplyMock).not.toHaveBeenCalled();
  });
});
