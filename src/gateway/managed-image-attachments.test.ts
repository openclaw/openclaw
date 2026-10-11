// Managed image attachment tests cover storage, HTTP serving, cleanup, and
// operator authorization for generated image artifacts attached to gateway replies.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { maxBytesForKind } from "@openclaw/media-core/constants";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from "../config/sessions/targets-read-availability.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  completeSessionDelivery,
  enqueueSessionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import { readImageProbeFromHeader, resizeToJpeg } from "../media/image-ops.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../media/store-network.test-support.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createFixture,
  createManagedOutgoingImageBlocks,
  createManagedOutgoingImageBlocksWithoutHostSql,
  createPngDataUrl,
  expectPathMissing,
  prepareAgentSessionStore,
  prepareManagedSessionStore as seedManagedSessionStore,
  replaceTestSessionEntry,
  requireAttachmentIdFromUrl,
  requireBlock,
  requireManagedOriginalPath,
  TINY_PNG_BASE64,
  usePreparedManagedImageState,
  writeSource,
  type RequestResult,
} from "./managed-image-attachments.test-support.js";
import {
  attachManagedImageRecordsToMessage,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { makeMockHttpResponse } from "./test-http-response.js";

type PlaybackTranscodeResolution = Awaited<
  ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"]>
>;
type PlaybackMetadataForSourceResolver =
  (typeof import("../media/playback-transcode.js"))["resolvePlaybackMetadataForSource"];

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveSharedSecretHttpOperatorScopesMock = vi.fn();
const resolveOpenAiCompatibleHttpSenderIsOwnerMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const resolvePlaybackMetadataForSourceMock = vi.fn<PlaybackMetadataForSourceResolver>();
const resolvePlaybackTranscodeMock = vi.fn(async (): Promise<PlaybackTranscodeResolution> => ({
  kind: "passthrough",
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

let storeSaveSpy: MockInstance<typeof import("../media/fetch.js").saveRemoteMedia> | undefined;

beforeAll(async () => {
  // Spy after graph evaluation: importOriginal(fetch) can pull store into its mock cycle.
  const mediaFetch = await import("../media/fetch.js");
  const saveRemoteMedia = mediaFetch.saveRemoteMedia;
  storeSaveSpy = vi
    .spyOn(mediaFetch, "saveRemoteMedia")
    .mockImplementation(wrapStoreSaveRemoteMedia(saveRemoteMedia));
});

afterAll(() => {
  try {
    disposeStoreRemoteFixtures();
  } finally {
    storeSaveSpy?.mockRestore();
  }
});

beforeEach(() => {
  resolvePlaybackMetadataForSourceMock.mockReset();
  resolvePlaybackMetadataForSourceMock.mockImplementation(async ({ mimeType }) => ({
    playback: mimeType === "audio/x-caf" ? "transcode" : "native",
  }));
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveSharedSecretHttpOperatorScopes: resolveSharedSecretHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwnerMock,
}));

vi.mock("./session-utils-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store.js")>()),
  loadGatewaySessionEntry: loadSessionEntryMock,
  loadGatewaySessionEntryReadOnly: loadSessionEntryMock,
}));

vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesAsync: readSessionMessagesMock,
  readSessionMessagesMatchingIdAsync: async (scope: unknown, messageId: string) =>
    (await readSessionMessagesMock(scope)).filter(
      (message: { __openclaw?: { id?: string } }) => message["__openclaw"]?.id === messageId,
    ),
  readSessionMessagesWithSourceAsync: async (...args: unknown[]) => ({
    messages: await readSessionMessagesMock(...args),
  }),
}));

vi.mock("../media/playback-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/playback-transcode.js")>();
  resolvePlaybackMetadataForSourceMock.mockImplementation(async ({ mimeType }) => ({
    playback: mimeType === "audio/x-caf" ? "transcode" : "native",
  }));
  return {
    ...actual,
    resolvePlaybackMetadataForSource: resolvePlaybackMetadataForSourceMock,
    resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
  };
});

const {
  DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX,
  attachManagedOutgoingMediaToMessage: attachManagedOutgoingImagesToMessage,
  createManagedOutgoingMediaBlocks: createManagedOutgoingImageBlocksActual,
  cleanupManagedOutgoingMediaRecords: cleanupManagedOutgoingImageRecords,
  handleManagedOutgoingMediaHttpRequest: handleManagedOutgoingImageHttpRequest,
  prepareOutgoingMediaFromReplyPayload,
  readManagedOutgoingImageThumbnail,
  resolveManagedOutgoingMediaArtifactDownload: resolveManagedOutgoingImageArtifactDownload,
} = await import("./managed-image-attachments.js");
const { bindHttpResponseAuthority } = await import("./http-request-authority.js");

async function prepareManagedSessionStore(stateDir: string): Promise<void> {
  const store = await seedManagedSessionStore(stateDir);
  getRuntimeConfigMock.mockReturnValue({ session: { store } });
}

function assistantMessage(content: unknown) {
  return { role: "assistant", content, __openclaw: { id: "msg-1" } };
}

function mockSessionEntry(storePath: string, sessionId = "sess-1", sessionFile = "session.jsonl") {
  loadSessionEntryMock.mockReturnValue({ storePath, entry: { sessionId, sessionFile } });
}

function mediaPath(fixture: { sessionKey: string; attachmentId: string }) {
  return `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`;
}

function useManagedImageState(prefix: string, bindState: (stateDir: string) => void): void {
  usePreparedManagedImageState({
    prefix,
    bindState,
    prepareSessionStore: prepareManagedSessionStore,
    cleanupRecords: cleanupManagedOutgoingImageRecords,
    resetMocks: (stateDir) => {
      vi.clearAllMocks();
      authorizeGatewayHttpRequestOrReplyMock.mockReset();
      resolveSharedSecretHttpOperatorScopesMock.mockReset();
      resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReset();
      loadSessionEntryMock.mockReset();
      readSessionMessagesMock.mockReset();
      resolvePlaybackTranscodeMock.mockReset().mockResolvedValue({ kind: "passthrough" });
      getRuntimeConfigMock.mockReturnValue({
        session: { store: path.join(stateDir, "sessions.sqlite") },
      });
    },
  });
}

async function requestManagedImage(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: http.ClientRequestArgs["headers"];
  transcriptMessages?: Record<string, unknown>[];
  sessionEntry?: { sessionId: string; sessionFile?: string };
}) {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return bindHttpResponseAuthority({ ok: true, ...params.authResponse }, res, () => true);
  });
  resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockImplementation((_req, requestAuth) => {
    if (requestAuth.authMethod === "token" || requestAuth.authMethod === "password") {
      return true;
    }
    return (
      requestAuth.trustDeclaredOperatorScopes === true &&
      (params.scopes ?? ["operator.read"]).includes("operator.admin")
    );
  });
  loadSessionEntryMock.mockReturnValue({
    storePath: path.join(params.stateDir, "sessions.sqlite"),
    entry: params.sessionEntry ?? { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });
  readSessionMessagesMock.mockImplementation(
    async () =>
      params.transcriptMessages ?? [
        assistantMessage([{ type: "image", url: params.pathName, openUrl: params.pathName }]),
      ],
  );

  const auth = { mode: "test" } as never;
  const server = http.createServer((req, res) => {
    void (async () => {
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
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
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
        (res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of res) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          })();
        },
      );
      req.on("error", reject);
      req.end();
    });

    return { result, auth };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("handleManagedOutgoingImageHttpRequest", () => {
  let stateDir: string;
  useManagedImageState("managed-images-", (prepared) => {
    stateDir = prepared;
  });

  it("bounds future managed-media validators to the actual HTTP response date", async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
      const future = new Date(nowMs + 60_000);
      await fs.utimes(originalPath, future, future);
      const futureLastModified = (await fs.stat(originalPath)).mtime.toUTCString();
      const expectedLastModified = new Date(nowMs).toUTCString();
      const pathName = mediaPath({ sessionKey, attachmentId });
      const request = { stateDir, pathName, authResponse: { authMethod: "token" } };

      const initial = await requestManagedImage({ ...request, method: "HEAD" });
      expect(initial.result.statusCode).toBe(200);
      expect(initial.result.headers["last-modified"]).toBe(expectedLastModified);
      expect(Date.parse(initial.result.headers.date ?? "")).toBeGreaterThanOrEqual(
        Date.parse(expectedLastModified),
      );

      const partial = await requestManagedImage({
        ...request,
        headers: { range: "bytes=0-4", "if-range": expectedLastModified },
      });
      expect(partial.result.statusCode).toBe(206);
      expect(partial.result.headers["last-modified"]).toBe(expectedLastModified);

      const stale = await requestManagedImage({
        ...request,
        headers: { range: "bytes=0-4", "if-range": futureLastModified },
      });
      expect(stale.result.statusCode).toBe(200);

      const unchanged = await requestManagedImage({
        ...request,
        headers: { "if-none-match": String(initial.result.headers.etag) },
      });
      expect(unchanged.result.statusCode).toBe(304);
      expect(unchanged.result.headers["last-modified"]).toBe(expectedLastModified);

      const unsatisfiable = await requestManagedImage({
        ...request,
        headers: { range: "bytes=999-" },
      });
      expect(unsatisfiable.result.statusCode).toBe(416);
      expect(unsatisfiable.result.headers["last-modified"]).toBe(expectedLastModified);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("honors weak HEAD match before If-Range for managed media", async () => {
    const body = Buffer.from("0123456789");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "report.txt",
      contentType: "text/plain",
      body,
    });
    const pathName = mediaPath({ sessionKey, attachmentId });
    const request = {
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      transcriptMessages: [
        assistantMessage([{ type: "attachment", attachment: { url: pathName } }]),
      ],
    };
    const initial = await requestManagedImage(request);
    const etag = String(initial.result.headers.etag);
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

    const { result } = await requestManagedImage({
      ...request,
      method: "HEAD",
      headers: [
        "Host",
        "127.0.0.1",
        "if-none-match",
        `"not-the-current-tag", W/${etag}`,
        "range",
        "bytes=2-5",
        "if-range",
        '"stale"',
      ],
    });

    expect(result.statusCode).toBe(304);
    expect(result.headers.etag).toBe(etag);
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["content-disposition"]).toContain('filename="report.txt"');
    expect(result.headers["content-length"]).toBe(undefined);
    expect(result.headers["content-range"]).toBe(undefined);
    expect(result.body.toString("utf8")).toBe("");
  });

  it("revalidates managed media with If-Modified-Since before HEAD ranges", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const pathName = mediaPath({ sessionKey, attachmentId });
    const request = { stateDir, pathName, authResponse: { authMethod: "token" } };
    const initial = await requestManagedImage({ ...request, method: "HEAD" });
    const lastModified = initial.result.headers["last-modified"];
    expect(lastModified).toEqual(expect.any(String));

    const unchanged = await requestManagedImage({
      ...request,
      method: "HEAD",
      headers: {
        "if-modified-since": String(lastModified),
        range: "bytes=0-3",
        "if-range": '"stale"',
      },
    });

    expect(unchanged.result.statusCode).toBe(304);
    expect(unchanged.result.headers["last-modified"]).toBe(lastModified);
    expect(unchanged.result.headers["content-length"]).toBeUndefined();
    expect(unchanged.result.headers["content-range"]).toBeUndefined();
    expect(unchanged.result.body).toHaveLength(0);
  });

  it("serves a ticketed byte range from managed audio", async () => {
    const body = Buffer.from("original-audio");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "音声%20.mp3",
      contentType: "audio/mpeg",
      body,
    });
    const canonicalPath = mediaPath({ sessionKey, attachmentId });
    const transcriptMessages = [
      assistantMessage([{ type: "audio", url: canonicalPath, openUrl: canonicalPath }]),
    ];
    mockSessionEntry(path.join(stateDir, "gateway-sessions.json"));
    readSessionMessagesMock.mockResolvedValue(transcriptMessages);
    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: download?.url ?? "",
      denyAuth: true,
      headers: { range: "bytes=9-13" },
      transcriptMessages,
    });

    expect(download).toMatchObject({ type: "audio", title: "音声%20.mp3" });
    expect(result.headers["content-disposition"]).toContain(
      "filename*=UTF-8''%E9%9F%B3%E5%A3%B0%2520.mp3",
    );
    expect(result.statusCode).toBe(206);
    expect(result.headers["content-type"]).toBe("audio/mpeg");
    expect(result.headers["content-range"]).toBe(`bytes 9-13/${body.byteLength}`);
    expect(result.body.toString("utf8")).toBe("audio");
    const wrongAttachmentId = "22222222-2222-4222-8222-222222222222";
    const wrong = await requestManagedImage({
      stateDir,
      pathName: (download?.url ?? "").replace(attachmentId, wrongAttachmentId),
      denyAuth: true,
    });
    expect(wrong.result.statusCode).toBe(401);
    expect(authorizeGatewayHttpRequestOrReplyMock).toHaveBeenCalledTimes(1);
  });

  it("returns 202 while a managed playback transcode is preparing", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "preparing" });
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
      scopes: ["operator.admin"],
    });

    expect(result.statusCode).toBe(202);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({ status: "preparing" });
  });

  it("closes the opened managed-media descriptor when playback resolution rejects", async () => {
    const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });
    authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) =>
      bindHttpResponseAuthority({ ok: true, authMethod: "token" }, res, () => true),
    );
    resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(["operator.read"]);
    resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(true);
    mockSessionEntry(path.join(stateDir, "gateway-sessions.json"));
    readSessionMessagesMock.mockResolvedValue([
      assistantMessage([{ type: "audio", url: mediaPath({ sessionKey, attachmentId }) }]),
    ]);
    resolvePlaybackTranscodeMock.mockRejectedValueOnce(new Error("playback inspection failed"));
    const originalOpen = fs.open;
    let closeOpenedHandle: MockInstance<() => Promise<void>> | undefined;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === originalPath) {
        closeOpenedHandle = vi.spyOn(handle, "close");
      }
      return handle;
    });
    const { res } = makeMockHttpResponse();

    try {
      await expect(
        handleManagedOutgoingImageHttpRequest(
          {
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
            method: "GET",
            headers: {},
          } as http.IncomingMessage,
          res,
          { auth: { mode: "test" } as never, stateDir },
        ),
      ).rejects.toThrow("playback inspection failed");
      expect(closeOpenedHandle).toHaveBeenCalledOnce();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("serves byte ranges from a cached managed playback transcode", async () => {
    const transcodedPath = path.join(stateDir, "cached-voice.m4a");
    const transcoded = Buffer.from("normalized-audio");
    await fs.writeFile(transcodedPath, transcoded);
    const playback = {
      kind: "transcoded",
      path: transcodedPath,
      contentType: "audio/mp4",
      extension: ".m4a",
    } as const;
    resolvePlaybackTranscodeMock.mockResolvedValueOnce(playback);
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
      headers: { range: "bytes=11-15" },
    });

    expect(result.statusCode).toBe(206);
    expect(result.headers["content-type"]).toBe("audio/mp4");
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["last-modified"]).toBeUndefined();
    expect(result.headers["content-disposition"]).toContain('filename="voice.m4a"');
    expect(result.headers["content-range"]).toBe(`bytes 11-15/${transcoded.byteLength}`);
    expect(result.body.toString("utf8")).toBe("audio");

    for (const method of ["GET", "HEAD"]) {
      resolvePlaybackTranscodeMock.mockResolvedValueOnce(playback);
      const exists = await requestManagedImage({
        stateDir,
        pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
        authResponse: { authMethod: "token" },
        method,
        headers: { "if-none-match": "*", range: "bytes=11-15" },
      });
      expect(exists.result.statusCode).toBe(304);
      expect(exists.result.headers.etag).toBeUndefined();
      expect(exists.result.headers["content-length"]).toBeUndefined();
      expect(exists.result.body).toHaveLength(0);
    }
  });

  it("serves a sharp bounded 1600×800 thumbnail through local reads and the artifact ticket", async () => {
    const source = createSolidPngBuffer(1600, 800, { r: 24, g: 64, b: 128 });
    const { attachmentId, sessionKey } = await createFixture(stateDir, { body: source });
    const canonicalPath = mediaPath({ sessionKey, attachmentId });
    const transcriptMessages = [
      assistantMessage([{ type: "image", url: canonicalPath, openUrl: canonicalPath }]),
    ];
    mockSessionEntry(path.join(stateDir, "sessions.sqlite"));
    readSessionMessagesMock.mockResolvedValue(transcriptMessages);
    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });
    const thumbnailUrl = `${download?.url.replace(/\/full(?=\?)/u, "/thumbnail")}&v=2`;
    const localRequest = {
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
      maxBytes: 12 * 1024 * 1024,
      signal: new AbortController().signal,
    };
    const localThumbnail = await readManagedOutgoingImageThumbnail(localRequest);
    expect(localThumbnail && readImageProbeFromHeader(localThumbnail)).toMatchObject({
      width: 1200,
      height: 600,
    });
    await expect(
      readManagedOutgoingImageThumbnail({ ...localRequest, maxBytes: 1 }),
    ).rejects.toThrow("byte limit");
    await expect(
      readManagedOutgoingImageThumbnail({ ...localRequest, sessionKey: "agent:other:main" }),
    ).resolves.toBeNull();

    vi.clearAllMocks();
    const { result } = await requestManagedImage({
      stateDir,
      pathName: thumbnailUrl,
      denyAuth: true,
      transcriptMessages,
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("cat-thumbnail.png");
    expect(readImageProbeFromHeader(result.body)).toMatchObject({
      width: 1200,
      height: 600,
    });
    expect(result.body).toEqual(localThumbnail);
    expect(authorizeGatewayHttpRequestOrReplyMock).not.toHaveBeenCalled();
  });

  it("rejects a managed global artifact owned by another agent", async () => {
    const { attachmentId } = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "ops",
    });

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey: "global",
      agentId: "research",
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });

    expect(download).toBeNull();
  });

  it("rejects non-owner trusted-proxy requests with self-declared session ownership", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(403);
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

  it("rejects malformed encoded session keys", async () => {
    const { attachmentId } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/%E0%A4%A/${attachmentId}/full`,
      authResponse: { authMethod: "device-token" },
    });

    expect(result.statusCode).toBe(404);
  });
});

describe("createManagedOutgoingImageBlocks", () => {
  let stateDir: string;
  useManagedImageState("managed-image-blocks-", (prepared) => {
    stateDir = prepared;
  });

  function createImages(
    mediaUrls: string[],
    options: Omit<
      Parameters<typeof createManagedOutgoingImageBlocks>[0],
      "stateDir" | "sessionKey" | "mediaUrls"
    > = {},
  ) {
    return createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      stateDir,
      mediaUrls,
      ...options,
    });
  }

  it("prepares deduplicated media with metadata and per-item trust aligned by URL", () => {
    expect(
      prepareOutgoingMediaFromReplyPayload({
        mediaUrls: ["/tmp/a.json", "/tmp/a.json", "/tmp/b.json"],
        trustedLocalMedia: true,
        attachments: [
          {
            path: "/tmp/a.json",
            name: "a.json",
            mimeType: "application/json",
            trustedLocalMedia: false,
          },
          {
            path: "/tmp/b.json",
            name: "b.json",
            mimeType: "application/json",
            trustedLocalMedia: true,
          },
        ],
      }),
    ).toEqual([
      {
        url: "/tmp/a.json",
        filename: "a.json",
        mimeType: "application/json",
        trustedLocal: false,
      },
      {
        url: "/tmp/b.json",
        filename: "b.json",
        mimeType: "application/json",
        trustedLocal: true,
      },
    ]);
  });

  it("preserves safe generated image filenames in the record and HTTP response", async () => {
    const expectedName = "cover.png";
    const blocks = await createManagedOutgoingImageBlocksWithoutHostSql({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;charset=utf-8;base64,${TINY_PNG_BASE64}`],
      attachments: [{ type: "image", name: "../album\\cover\r\n.png" }],
      stateDir,
      messageId: "msg-1",
    });
    const block = requireBlock(blocks);
    const attachmentId = requireAttachmentIdFromUrl(block.url);
    expect(blocks).toHaveLength(1);
    expect(block.type).toBe("image");
    expect(block.alt).toBe("Generated image 1");
    expect(block.mimeType).toBe("image/png");
    expect(block.url).toBe(block.openUrl);
    expect(String(block.url)).toMatch(/\/full$/);

    expect(block.artifactId).toBe(`${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`);
    expect(block.sizeBytes).toBe(Buffer.from(TINY_PNG_BASE64, "base64").byteLength);
    const record = await readManagedImageRecord(attachmentId, stateDir);
    expect(record?.original.mediaSubdir).toBe(MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    expect(record?.original.mediaId).toMatch(/\.png$/);

    expect(record?.original.filename).toBe(expectedName);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: String(block.url),
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-disposition"]).toContain(`filename="${expectedName}"`);
  });

  it("sanitizes generated video filenames in media blocks, records, and downloads", async () => {
    const kind = "video";
    const expectedName = "NUL_.mp4";
    const sourcePath = path.join(stateDir, "workspace", "clip.mp4");
    await writeSource(
      sourcePath,
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
    );
    const blocks = await createImages([sourcePath], {
      attachments: [{ type: kind, path: sourcePath, name: "../album\\NUL\r\n.webp" }],
      localRoots: [path.dirname(sourcePath)],
      allowLocalNonImage: true,
      messageId: "msg-1",
    });
    const block = requireBlock(blocks);
    const pathName = String(block.url);

    expect(block).toMatchObject({ type: kind, fileName: expectedName });
    expect(
      (await readManagedImageRecord(requireAttachmentIdFromUrl(pathName), stateDir))?.original
        .filename,
    ).toBe(expectedName);

    const { result } = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      transcriptMessages: [assistantMessage([{ type: kind, url: pathName, openUrl: pathName }])],
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-disposition"]).toContain(`filename="${expectedName}"`);
  });

  it("publishes managed media while both inspection slots remain occupied", async () => {
    const actual = await vi.importActual<typeof import("../media/playback-transcode.js")>(
      "../media/playback-transcode.js",
    );
    resolvePlaybackMetadataForSourceMock.mockImplementation(
      actual.resolvePlaybackMetadataForSource,
    );
    const mediaProbe = await import("../media/media-probe.js");
    const entered = createDeferred();
    const release = createDeferred();
    let started = 0;
    const probe = vi
      .spyOn(mediaProbe, "probePlaybackMediaFileDescriptor")
      .mockImplementation(async () => {
        if (++started === 2) {
          entered.resolve();
        }
        await release.promise;
        return { durationMs: 1000, audioCodec: "mp3", audioStreamIndex: 0 };
      });
    const abort = new AbortController();
    const pending: Promise<unknown>[] = [];
    onTestFinished(async () => {
      abort.abort();
      release.resolve();
      await Promise.allSettled(pending);
      probe.mockRestore();
    });
    for (const name of ["held-a.mp3", "held-b.mp3"]) {
      const filePath = path.join(stateDir, name);
      await fs.writeFile(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      const sourcePath = await fs.realpath(filePath);
      pending.push(
        actual.resolvePlaybackMetadataForSource({
          sourcePath,
          sourceStat: await fs.stat(sourcePath),
          mimeType: "audio/mpeg",
          kind: "audio",
        }),
      );
    }
    await entered.promise;
    const onPrepareError = vi.fn();
    const creation = createImages(["data:audio/mpeg;base64,//uQAA=="], {
      abortSignal: abort.signal,
      continueOnPrepareError: true,
      onPrepareError,
    });
    pending.push(creation);
    const blocks = await creation;
    expect(onPrepareError).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
    const block = requireBlock(blocks);
    expect(block).toMatchObject({ type: "audio", mimeType: "audio/mpeg" });
    expect(
      await readManagedImageRecord(requireAttachmentIdFromUrl(block.url), stateDir),
    ).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("returns a visible failure without publishing a record when playback inspection fails", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.mp3");
    await writeSource(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    resolvePlaybackMetadataForSourceMock.mockRejectedValueOnce(
      new Error("synthetic playback inspection failure"),
    );

    const blocks = await createImages([sourcePath], {
      localRoots: [path.dirname(sourcePath)],
      allowLocalNonImage: true,
      continueOnPrepareError: true,
    });

    expect(blocks).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "audio",
          label: "voice.mp3",
          mimeType: "audio/mpeg",
        },
      },
    ]);
    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
    await expectPathMissing(path.join(stateDir, "media", "outgoing", "originals"));
  });

  it("caps managed video data URLs by media kind", async () => {
    const oversized = Buffer.alloc(maxBytesForKind("video") + 1).toString("base64");
    await expect(createImages([`data:video/mp4;base64,${oversized}`])).rejects.toThrow(
      /Managed video attachment.*16 MiB byte limit/,
    );
  });

  it("requires explicit reply trust for local audio", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.mp3");
    await writeSource(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    await expect(
      createImages([sourcePath], {
        localRoots: [path.join(stateDir, "workspace")],
      }),
    ).rejects.toThrow(/Managed audio attachment.*could not be prepared/u);
  });

  it("rejects oversized image data urls before decoding the payload", async () => {
    const oversizedDataUrl = "data:image/png;base64,AAAAAA==";

    await expect(
      createImages([oversizedDataUrl], {
        limits: {
          ...DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
          maxBytes: 3,
        },
      }),
    ).rejects.toThrow(/Generated image 1.*byte limit/);

    await expectPathMissing(path.join(stateDir, "media", "outgoing", "records"));
  });

  it("rejects semicolon-heavy malformed data urls without backtracking", async () => {
    const semicolons = ";".repeat(64);
    const malformed = `data:image/png${semicolons}`;

    await expect(createImages([malformed])).rejects.toThrow("Invalid image data URL");
  });

  it("rejects data urls without a media type", async () => {
    await expect(createImages([`data:;base64,${TINY_PNG_BASE64}`])).rejects.toThrow(
      "Invalid image data URL",
    );
  });

  it("rewrites file URLs into managed display blocks without leaking the source path", async () => {
    const sourcePath = path.join(stateDir, "workspace", "fixtures", "dot.png");
    await writeSource(sourcePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const sourceUrl = pathToFileURL(sourcePath);
    sourceUrl.searchParams.set("sig", "secret");
    sourceUrl.hash = "preview";

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const blocks = await createImages([sourceUrl.href], {
        localRoots: [path.join(stateDir, "workspace")],
      });

      expect(blocks).toHaveLength(1);
      const block = requireBlock(blocks);
      expect(block.type).toBe("image");
      expect(block.url).toContain("/api/chat/media/outgoing/agent%3Amain%3Amain/");
      expect(block.openUrl).toContain("/full");
      expect(block.url).toBe(block.openUrl);
      expect(block.alt).toBe("dot.png");
      expect(JSON.stringify(block)).not.toContain(sourcePath);
      expect(JSON.stringify(block)).not.toContain("sig=secret");
      expect(JSON.stringify(block)).not.toContain("preview");

      const attachmentId = requireAttachmentIdFromUrl(block.url);
      const record = await readManagedImageRecord(attachmentId, stateDir);
      const originalPath = await requireManagedOriginalPath(stateDir, attachmentId);
      expect(record?.original.filename).toMatch(/\.png$/);
      expect(originalPath).not.toBe(sourcePath);
      expect(originalPath).toContain(path.join(stateDir, "media", "outgoing", "originals"));
    });
  });

  it("ingests external image URLs into managed storage instead of hotlinking them", async () => {
    const imageBuffer = createNoisyPngBuffer(1600, 1200);
    expect(imageBuffer.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    expect(imageBuffer.byteLength).toBeLessThan(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxBytes);
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/remote-cat.png?sig=secret");
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(imageBuffer);
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address() as AddressInfo;

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sourceUrl = `http://127.0.0.1:${address.port}/remote-cat.png?sig=secret`;
        const matchedUrls: string[] = [];
        const blocks = await withStoreRemoteFixture(
          { url: sourceUrl, onMatch: (url) => matchedUrls.push(url) },
          () => createImages([sourceUrl]),
        );
        expect(matchedUrls).toEqual([sourceUrl]);

        expect(blocks).toHaveLength(1);
        const block = requireBlock(blocks);
        expect(block.alt).toBe("remote-cat.png");
        expect(block.type).toBe("image");
        expect(block.url).toContain("/api/chat/media/outgoing/agent%3Amain%3Amain/");
        expect(block.openUrl).toContain("/full");
        expect(block.url).toBe(block.openUrl);
        expect(JSON.stringify(block)).not.toContain("127.0.0.1");
        expect(JSON.stringify(block)).not.toContain("sig=secret");

        const attachmentId = requireAttachmentIdFromUrl(block.url);
        const record = await readManagedImageRecord(attachmentId, stateDir);
        const originalPath = await requireManagedOriginalPath(stateDir, attachmentId);
        expect(originalPath).toContain(path.join(stateDir, "media", "outgoing", "originals"));
        expect(JSON.stringify(record)).not.toContain("127.0.0.1");
        expect(JSON.stringify(record)).not.toContain("sig=secret");
        expect(await fs.readFile(originalPath)).toEqual(imageBuffer);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports display dimensions in resize warnings for orientation 6", async () => {
    const jpeg = await resizeToJpeg({
      buffer: createSolidPngBuffer(200, 120, { r: 24, g: 64, b: 128 }),
      maxSide: 200,
      quality: 80,
    });
    // EXIF IFD0 contains one SHORT orientation tag; pixel axes remain 200×120.
    const exif = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000100000000000000",
      "hex",
    );
    exif.writeUInt16LE(6, 28);
    const rotated = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
    expect(readImageProbeFromHeader(rotated)).toMatchObject({
      width: 200,
      height: 120,
      orientation: 6,
    });
    const mediaUrl = `data:image/jpeg;base64,${rotated.toString("base64")}`;
    const blocks = await createImages([mediaUrl], {
      attachments: [{ type: "image", name: "generated-poster.webp" }],
      limits: { maxWidth: 64, maxHeight: 64, maxPixels: 4096 },
    });

    const record = await readManagedImageRecord(
      requireAttachmentIdFromUrl(blocks[0]?.url),
      stateDir,
    );
    expect(record?.original).toMatchObject({
      contentType: "image/jpeg",
      filename: "generated-poster.jpg",
      mediaId: expect.stringMatching(/\.jpg$/),
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("image");
    expect(requireBlock(blocks, 1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("resized from 120×200 to "),
    });
  });

  it("returns an error block for malformed media data URLs and keeps later media", async () => {
    const onPrepareError = vi.fn();
    const blocks = await createImages(
      ["data:audio/mpeg;base64,not-valid!", await createPngDataUrl(8, 8)],
      { continueOnPrepareError: true, onPrepareError },
    );

    expect(blocks).toHaveLength(2);
    expect(requireBlock(blocks)).toMatchObject({
      type: "attachment_error",
      attachment: { code: "delivery-failed", kind: "audio" },
    });
    expect(requireBlock(blocks, 1).type).toBe("image");
    expect(onPrepareError).toHaveBeenCalledOnce();
  });

  it("rejects unsupported application/octet-stream metadata before persistence", async () => {
    const fixture = {
      fileName: "mystery.blob",
      mimeType: "application/octet-stream",
      body: Buffer.from([0, 1, 2, 3]),
    };
    const sourcePath = path.join(stateDir, "workspace", fixture.fileName);
    await writeSource(sourcePath, fixture.body);

    const onPrepareError = vi.fn();
    const blocks = await createManagedOutgoingImageBlocksActual({
      sessionKey: "agent:main:main",
      items: [
        {
          url: sourcePath,
          filename: fixture.fileName,
          mimeType: fixture.mimeType,
          trustedLocal: true,
        },
      ],
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "document",
          label: fixture.fileName,
          mimeType: fixture.mimeType,
        },
      },
    ]);
    expect(onPrepareError).toHaveBeenCalledOnce();
    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
    const originalsDir = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    await expectPathMissing(originalsDir);
  });

  it("does not serve legacy SVG records over GET", async () => {
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "vector.svg",
      contentType: "image/svg+xml",
      body,
    });
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;

    const { result } = await requestManagedImage({
      stateDir,
      pathName,
      method: "GET",
      authResponse: { authMethod: "token" },
      transcriptMessages: [
        assistantMessage([
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "vector.svg",
              mimeType: "image/svg+xml",
              url: pathName,
            },
          },
        ]),
      ],
    });

    expect(result.statusCode).toBe(404);
    expect(result.headers["content-disposition"]).toBeUndefined();
    expect(result.body).toEqual(Buffer.from("not found"));
  });

  it("rolls back earlier managed artifacts when a later item fails", async () => {
    const sourcePath = path.join(stateDir, "workspace", "mystery.blob");
    await writeSource(sourcePath, Buffer.from([0, 1, 2, 3]));

    await expect(
      createManagedOutgoingImageBlocksActual({
        sessionKey: "agent:main:main",
        items: [
          {
            url: `data:image/png;base64,${TINY_PNG_BASE64}`,
            trustedLocal: false,
          },
          { url: sourcePath, trustedLocal: true },
        ],
        stateDir,
        localRoots: [path.dirname(sourcePath)],
      }),
    ).rejects.toThrow(/could not be prepared/u);

    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
  });

  it("rejects relative local image paths that resolve outside allowed roots", async () => {
    const allowedWorkspaceDir = path.join(stateDir, "workspace");
    const outsidePath = path.join(stateDir, "outside.png");
    await fs.mkdir(allowedWorkspaceDir, { recursive: true });
    await fs.writeFile(outsidePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(allowedWorkspaceDir);
    try {
      await expect(
        createImages(["../outside.png"], {
          localRoots: [allowedWorkspaceDir],
        }),
      ).rejects.toThrow(/could not be prepared/i);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("creates managed document attachment envelopes for trusted local files", async () => {
    const pdfPath = path.join(stateDir, "not-an-image.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.4\n% test\n"));

    const blocks = await createImages([pdfPath], {
      localRoots: [stateDir],
      allowLocalNonImage: true,
      messageId: "msg-1",
    });

    expect(blocks).toEqual([
      {
        type: "attachment",
        attachment: expect.objectContaining({
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          kind: "document",
          label: "not-an-image.pdf",
          mimeType: "application/pdf",
          sizeBytes: 16,
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\//u),
        }),
      },
    ]);

    const attachment = (blocks[0] as { attachment?: { artifactId?: string; url?: string } })
      .attachment;
    const { result } = await requestManagedImage({
      stateDir,
      pathName: attachment?.url ?? "",
      authResponse: { authMethod: "token" },
      transcriptMessages: [assistantMessage(blocks)],
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("application/pdf");
    expect(result.headers["content-disposition"]).toContain("attachment;");
    expect(result.body).toEqual(Buffer.from("%PDF-1.4\n% test\n"));

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey: "agent:main:main",
      artifactId: attachment?.artifactId ?? "",
      stateDir,
    });
    expect(download).toMatchObject({
      artifactId: attachment?.artifactId,
      type: "file",
      title: "not-an-image.pdf",
      mimeType: "application/pdf",
      sizeBytes: 16,
    });
  });
});

describe("attachManagedOutgoingImagesToMessage", () => {
  let stateDir: string;
  useManagedImageState("managed-image-attach-", (prepared) => {
    stateDir = prepared;
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

    const attachmentId = requireAttachmentIdFromUrl(blocks[0]?.url);
    const record = await readManagedImageRecord(attachmentId, stateDir);
    expect(record?.messageId).toBe("msg-committed");
    expect(record?.retentionClass).toBe("history");
    expect(typeof record?.updatedAt).toBe("string");
  });
});

describe("cleanupManagedOutgoingImageRecords", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-cleanup-");
    vi.clearAllMocks();
    await prepareManagedSessionStore(stateDir);
  });

  it("retains an aged transient record while its session still has an active run", async () => {
    const fixture = await createFixture(stateDir, {
      messageId: null,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });

    const checkedSessionKeys: string[] = [];
    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      hasActiveSessionRun: (sessionKey) => {
        checkedSessionKeys.push(sessionKey);
        return sessionKey === fixture.sessionKey;
      },
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(checkedSessionKeys).toEqual([fixture.sessionKey]);
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(
      await attachManagedImageRecordsToMessage({
        attachments: [fixture],
        messageId: "msg-late",
        updatedAt: new Date().toISOString(),
        stateDir,
      }),
    ).toBe(true);
    const attached = await readManagedImageRecord(fixture.attachmentId, stateDir);
    expect(attached?.messageId).toBe("msg-late");
    expect(attached?.retentionClass).toBe("history");
  });

  it("retains transient records referenced by pending prepared session delivery", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });
    const attachmentId = requireAttachmentIdFromUrl(blocks[0]?.url);
    const record = await readManagedImageRecord(attachmentId, stateDir);
    if (!record) {
      throw new Error("expected pending managed media record");
    }
    const queueContext = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const queueId = await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "deliver generated image",
        messageId: "generated-image-agent-turn",
        expectedMediaUrls: ["/tmp/generated.png"],
        preparedMediaBlocks: {
          "/tmp/generated.png": blocks as Array<Record<string, unknown>>,
        },
      },
      queueContext,
    );
    const afterTtl = Date.parse(record.createdAt) + 16 * 60 * 1000;

    await expect(
      cleanupManagedOutgoingImageRecords({ stateDir, nowMs: afterTtl }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });

    await completeSessionDelivery(queueId, queueContext);
    await expect(
      cleanupManagedOutgoingImageRecords({ stateDir, nowMs: afterTtl }),
    ).resolves.toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
  });

  it("retries a durably claimed file deletion after a filesystem failure", async () => {
    const fixture = await createFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("synthetic rm failure"));

    let failed: Awaited<ReturnType<typeof cleanupManagedOutgoingImageRecords>>;
    try {
      failed = await cleanupManagedOutgoingImageRecords({ stateDir });
    } finally {
      rmSpy.mockRestore();
    }

    expect(failed).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await readManagedImageRecord(fixture.attachmentId, stateDir)).toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();

    const retried = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(retried).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    await expectPathMissing(fixture.originalPath);
  });

  it("reaps aged files left before a SQLite record was committed", async () => {
    const orphanPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "orphan.png",
    );
    await writeSource(orphanPath, "orphan");
    await fs.utimes(orphanPath, new Date(0), new Date(0));

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: 1_000_000,
      transientMaxAgeMs: 1_000,
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 1, retainedCount: 0 });
    await expectPathMissing(orphanPath);
  });

  it("does not reap old unindexed files while legacy metadata still exists", async () => {
    const orphanPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "legacy-owned.png",
    );
    const legacyRecordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      "11111111-1111-4111-8111-111111111111.json",
    );
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyRecordPath), { recursive: true });
    await fs.writeFile(orphanPath, "legacy");
    await fs.writeFile(legacyRecordPath, "{}");
    await fs.utimes(orphanPath, new Date(0), new Date(0));

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: 1_000_000,
      transientMaxAgeMs: 1_000,
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
  });

  it("does not let a valid fallback mask an unreadable exact row", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    opened.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run("agent:main:main", "broken-session", "{invalid", Date.now());
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    getRuntimeConfigMock.mockReturnValue({ session: { store: databasePath } });
    mockSessionEntry(databasePath, "fallback-session", "/tmp/fallback.jsonl");

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("does not assign the configured fixed store to a retired agent", async () => {
    const fixture = await createFixture(stateDir, {
      agentId: "retired",
      sessionKey: "agent:retired:main",
    });
    const storePath = path.join(stateDir, "current-sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await replaceTestSessionEntry(
      { agentId: "main", env, storePath, sessionKey: "agent:main:main" },
      { sessionId: "current-session", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    const config = {
      session: { store: storePath },
      agents: {
        ownership: "explicit" as const,
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {} },
      },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, "main", { env }),
    ).toMatchObject({
      available: true,
      targets: [{ agentId: "main", storePath }],
    });
    loadSessionEntryMock.mockReturnValue({ storePath, entry: undefined });

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    expect(await fs.readFile(fixture.originalPath, "utf8")).toBe("original-image");
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history when a healthy configured store masks an unreadable candidate", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "custom", "{agentId}", "sessions.json");
    const configuredStorePath = storeTemplate.replace("{agentId}", "main");
    const configuredTarget = resolveSqliteTargetFromSessionStorePath(configuredStorePath, {
      agentId: "main",
      env,
    });
    openOpenClawAgentDatabase({ agentId: "main", env, path: configuredTarget.path });
    closeOpenClawAgentDatabasesForTest();
    const discoveredDatabasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(discoveredDatabasePath);
    database.exec("DROP TABLE session_nodes;");
    database.close();
    getRuntimeConfigMock.mockReturnValue({ session: { store: storeTemplate } });
    loadSessionEntryMock.mockReturnValue({ storePath: configuredStorePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("reads each session transcript once while evaluating committed records", async () => {
    const firstFixture = await createFixture(stateDir, {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "att-1.png",
    });
    const secondFixture = await createFixture(stateDir, {
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "att-2.png",
    });
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
            url: `/api/chat/media/outgoing/${encodeURIComponent(firstFixture.sessionKey)}/${firstFixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(firstFixture.sessionKey)}/${firstFixture.attachmentId}/full`,
          },
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(secondFixture.sessionKey)}/${secondFixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(secondFixture.sessionKey)}/${secondFixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result.deletedRecordCount).toBe(0);
    expect(result.deletedFileCount).toBe(0);
    expect(result.retainedCount).toBe(2);
    await expect(fs.access(firstFixture.originalPath)).resolves.toBeUndefined();
    await expect(fs.access(secondFixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not delete files still referenced by other sessions during session-scoped cleanup", async () => {
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "agent:other:session",
      attachmentId: "33333333-3333-4333-8333-333333333333",
    });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "agent:main:main",
      attachmentId: "44444444-4444-4444-8444-444444444444",
    });

    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: {
        sessionId: sessionKey === retainedFixture.sessionKey ? "sess-other" : "sess-main",
        sessionFile: "/tmp/session.jsonl",
      },
    }));
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: deletedFixture.sessionKey,
      forceDeleteSessionRecords: true,
    });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
  });

  it("retains other selected-agent global records during scoped cleanup", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
      session: { store: path.join(stateDir, "sessions.sqlite") },
    });
    await replaceTestSessionEntry(
      {
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
        storePath: path.join(stateDir, "sessions.sqlite"),
      },
      { sessionId: "sess-main-global", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "work",
      attachmentId: "55555555-5555-4555-8555-555555555555",
    });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "main",
      attachmentId: "66666666-6666-4666-8666-666666666666",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main-global", sessionFile: "/tmp/global-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
      agentId: "main",
    });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
    await expectPathMissing(deletedFixture.originalPath);
  });

  it("uses the recorded owner for unscoped session keys", async () => {
    const sessionKey = "legacy-session";
    const fixture = await createFixture(stateDir, {
      sessionKey,
      agentId: "work",
    });
    getRuntimeConfigMock.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
      session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
    });
    prepareAgentSessionStore(stateDir, "work");
    await replaceTestSessionEntry(
      {
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey,
      },
      { sessionId: "sess-work", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "agents", "work", "sessions", "sessions.json"),
      entry: { sessionId: "sess-work", sessionFile: "/tmp/work.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${fixture.sessionKey}/${fixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(readSessionMessagesMock).toHaveBeenCalled();
    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
  });

  it("treats legacy unscoped global records as the configured default agent", async () => {
    const { config } = createCanonicalAgentConfigFixture({
      agents: { list: [{ id: "main" }, { id: "work", default: true }] },
    });
    getRuntimeConfigMock.mockReturnValue(config);
    prepareAgentSessionStore(stateDir, "work");
    await replaceTestSessionEntry(
      {
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
      },
      { sessionId: "sess-work-global", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, "work", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toMatchObject({ available: true });
    const { loadExactSessionEntryReadOnlyResult } =
      await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
    expect(
      loadExactSessionEntryReadOnlyResult({
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
      }),
    ).toMatchObject({ found: true, value: { sessionKey: "global" } });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      attachmentId: "88888888-8888-4888-8888-888888888888",
    });
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "main",
      attachmentId: "99999999-9999-4999-8999-999999999999",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-work-global", sessionFile: "/tmp/global-work.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
      agentId: "work",
    });

    expect(readSessionMessagesMock).toHaveBeenCalled();
    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expectPathMissing(deletedFixture.originalPath);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
  });

  it("retains ownerless global records when no compatibility owner exists", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { entries: { main: {}, work: {} } },
    });
    const fixture = await createFixture(stateDir, {
      sessionKey: "global",
      attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(await readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
