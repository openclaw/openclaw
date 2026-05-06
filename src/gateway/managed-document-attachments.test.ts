import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  readSessionMessagesAsync: readSessionMessagesMock,
}));

vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: getLatestSubagentRunByChildSessionKeyMock,
}));

const {
  DEFAULT_MANAGED_DOCUMENT_ATTACHMENT_LIMITS,
  attachManagedOutgoingDocumentsToMessage,
  cleanupManagedOutgoingDocumentRecords,
  handleManagedOutgoingDocumentHttpRequest,
  resolveManagedDocumentAttachmentLimits,
} = await import("./managed-document-attachments.js");

type RequestResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSX_ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = "agent:main:main";

async function createDocumentFixture(
  stateDir: string,
  options?: {
    sessionKey?: string;
    attachmentId?: string;
    filename?: string;
    contentType?: string;
    label?: string;
    body?: Buffer;
    messageId?: string | null;
  },
) {
  const attachmentId = options?.attachmentId ?? XLSX_ATTACHMENT_ID;
  const sessionKey = options?.sessionKey ?? SESSION_KEY;
  const filename = options?.filename ?? `${attachmentId}-pricing-full.xlsx`;
  const label = options?.label ?? "pricing.xlsx";
  const contentType = options?.contentType ?? XLSX_MIME;
  const body = options?.body ?? Buffer.from("pretend-xlsx-bytes");
  const originalPath = path.join(stateDir, "files", filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, body);
  const record: Record<string, unknown> = {
    attachmentId,
    sessionKey,
    messageId: options?.messageId === undefined ? "msg-1" : options.messageId,
    createdAt: new Date().toISOString(),
    label,
    original: {
      path: originalPath,
      contentType,
      sizeBytes: body.byteLength,
      filename: label,
    },
  };
  const recordsDir = path.join(stateDir, "media", "outgoing-docs", "records");
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.writeFile(
    path.join(recordsDir, `${attachmentId}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return { attachmentId, sessionKey, originalPath, label, contentType };
}

async function requestManagedDocument(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: Record<string, string>;
  transcriptMessages?: Record<string, unknown>[];
  subagentRun?: Record<string, unknown> | null;
  sessionEntry?: { sessionId: string; sessionFile?: string };
  attachmentIdInTranscript?: string;
  sessionKeyInTranscript?: string;
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
    entry: params.sessionEntry ?? { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });

  const transcriptMessages = params.transcriptMessages ?? [
    {
      role: "assistant",
      content: [
        {
          type: "attachment",
          attachment: {
            url: `/api/chat/media/outgoing-doc/${encodeURIComponent(
              params.sessionKeyInTranscript ?? SESSION_KEY,
            )}/${params.attachmentIdInTranscript ?? XLSX_ATTACHMENT_ID}/full`,
            kind: "document",
            label: "pricing.xlsx",
            mimeType: XLSX_MIME,
          },
        },
      ],
      __openclaw: { id: "msg-1" },
    },
  ];
  readSessionMessagesMock.mockReturnValue(transcriptMessages);

  const auth = { mode: "test" } as never;
  const server = http.createServer(async (req, res) => {
    const handled = await handleManagedOutgoingDocumentHttpRequest(req, res, {
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

    return { result };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("resolveManagedDocumentAttachmentLimits", () => {
  it("preserves the public default shape", () => {
    expect(resolveManagedDocumentAttachmentLimits()).toEqual(
      DEFAULT_MANAGED_DOCUMENT_ATTACHMENT_LIMITS,
    );
  });

  it("lets callers tighten the byte cap", () => {
    expect(resolveManagedDocumentAttachmentLimits({ maxBytes: 1024 })).toEqual({
      maxBytes: 1024,
    });
  });
});

describe("handleManagedOutgoingDocumentHttpRequest — Bug #9", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-docs-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("serves an xlsx with the correct Content-Type and an attachment Content-Disposition", async () => {
    // The whole point of Bug #9: Todd's browser must see attachment;filename=
    // for the Excel file, not inline (which is what the image module emits).
    const { attachmentId, sessionKey, contentType, label } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe(contentType);
    expect(result.headers["content-disposition"]).toBe(`attachment; filename="${label}"`);
    expect(result.body.toString("utf-8")).toBe("pretend-xlsx-bytes");
  });

  it("serves a pdf with attachment disposition", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir, {
      attachmentId: "22222222-2222-4222-9222-222222222222",
      filename: "report.pdf",
      label: "report.pdf",
      contentType: "application/pdf",
      body: Buffer.from("%PDF-1.4 fake"),
    });

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
      attachmentIdInTranscript: attachmentId,
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("application/pdf");
    expect(result.headers["content-disposition"]).toBe('attachment; filename="report.pdf"');
  });

  it("sanitizes filenames containing CR/LF/quote/path characters", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir, {
      attachmentId: "33333333-3333-4333-8333-333333333333",
      filename: 'evil"\\name.xlsx',
      label: 'evil"\r\n/name.xlsx',
    });

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
      attachmentIdInTranscript: attachmentId,
    });

    expect(result.statusCode).toBe(200);
    const disposition = String(result.headers["content-disposition"]);
    // The header is well-formed: starts with `attachment; filename="…"` with
    // no raw CR, LF, double-quote, backslash, or slash inside the filename.
    expect(disposition).toMatch(/^attachment; filename="[^"\\\r\n/]+"$/);
    // The label has 4 disallowed chars (", \r, \n, /), each replaced with _.
    expect(disposition).toBe('attachment; filename="evil____name.xlsx"');
  });

  it("rejects unauthenticated requests before serving bytes", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      denyAuth: true,
    });

    expect(result.statusCode).toBe(401);
    expect(result.body.byteLength).toBe(0);
  });

  it("rejects requests from unrelated requester sessions", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": "agent:main:other" },
    });

    expect(result.statusCode).toBe(403);
  });

  it("allows device-token access without requester session ownership", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "device-token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-disposition"]).toContain("attachment");
  });

  it("returns 404 when the transcript no longer references the attachment", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
      transcriptMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "no attachments here" }],
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(result.statusCode).toBe(404);
  });

  it("rejects malformed attachment ids with 404", async () => {
    const { sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/not-a-uuid/full`,
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(404);
  });

  it("rejects non-GET methods with 405", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);

    const { result } = await requestManagedDocument({
      stateDir,
      pathName: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      method: "POST",
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(405);
  });

  it("returns false (not handled) for unrelated paths", async () => {
    // The route handler should defer to other routes for paths that aren't
    // /api/chat/media/outgoing-doc/.../full. We assert via the test server's
    // fall-through 404 with `unhandled` body.
    const auth = { mode: "test" } as never;
    const server = http.createServer(async (req, res) => {
      const handled = await handleManagedOutgoingDocumentHttpRequest(req, res, {
        auth,
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: false,
        stateDir,
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
            path: "/api/chat/media/outgoing/foo/bar/full",
            method: "GET",
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
      expect(result.statusCode).toBe(404);
      expect(result.body.toString("utf-8")).toBe("unhandled");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("attachManagedOutgoingDocumentsToMessage", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-docs-attach-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("promotes a transient document to history retention when bound to a message id", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir, {
      messageId: null,
    });
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing-docs",
      "records",
      `${attachmentId}.json`,
    );
    const before = JSON.parse(await fs.readFile(recordPath, "utf-8")) as {
      messageId: string | null;
      retentionClass?: string;
    };
    expect(before.messageId).toBeNull();
    expect(before.retentionClass).toBeUndefined();

    await attachManagedOutgoingDocumentsToMessage({
      messageId: "msg-99",
      stateDir,
      blocks: [
        {
          type: "attachment",
          attachment: {
            url: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
            kind: "document",
            label: "pricing.xlsx",
            mimeType: XLSX_MIME,
          },
        },
      ],
    });

    const after = JSON.parse(await fs.readFile(recordPath, "utf-8")) as {
      messageId: string | null;
      retentionClass?: string;
    };
    expect(after.messageId).toBe("msg-99");
    expect(after.retentionClass).toBe("history");
  });

  it("ignores blocks that are not document attachment refs", async () => {
    // No record exists, so a no-op caller must not throw and must not create
    // any side effects.
    await expect(
      attachManagedOutgoingDocumentsToMessage({
        messageId: "msg-99",
        stateDir,
        blocks: [
          { type: "text", text: "hello" },
          {
            type: "image",
            url: "/api/chat/media/outgoing/foo/11111111-1111-4111-8111-111111111111/full",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("cleanupManagedOutgoingDocumentRecords", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-docs-cleanup-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("removes transient records past their TTL and their files", async () => {
    const { attachmentId, originalPath } = await createDocumentFixture(stateDir, {
      messageId: null,
    });
    // Backdate the record's createdAt so the cleanup considers it expired.
    const recordPath = path.join(
      stateDir,
      "media",
      "outgoing-docs",
      "records",
      `${attachmentId}.json`,
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf-8")) as Record<string, unknown>;
    record.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await fs.writeFile(recordPath, JSON.stringify(record), "utf-8");

    const result = await cleanupManagedOutgoingDocumentRecords({
      stateDir,
      transientMaxAgeMs: 1, // anything > 1ms old gets swept
    });

    expect(result.deletedRecordCount).toBeGreaterThanOrEqual(1);
    await expect(fs.access(recordPath)).rejects.toBeTruthy();
    await expect(fs.access(originalPath)).rejects.toBeTruthy();
  });

  it("retains records whose messageId still appears in the transcript", async () => {
    const { attachmentId, sessionKey } = await createDocumentFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              url: `/api/chat/media/outgoing-doc/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
              kind: "document",
              label: "pricing.xlsx",
              mimeType: XLSX_MIME,
            },
          },
        ],
        __openclaw: { id: "msg-1" },
      },
    ]);

    const result = await cleanupManagedOutgoingDocumentRecords({ stateDir });

    expect(result.retainedCount).toBe(1);
    expect(result.deletedRecordCount).toBe(0);
  });

  it("returns zeros when no records directory exists yet", async () => {
    const emptyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-docs-empty-"));
    try {
      const result = await cleanupManagedOutgoingDocumentRecords({ stateDir: emptyStateDir });
      expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
    } finally {
      await fs.rm(emptyStateDir, { recursive: true, force: true });
    }
  });
});
