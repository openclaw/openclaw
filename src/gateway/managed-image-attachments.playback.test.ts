import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  observePlaybackSourceOpen,
  waitForPlaybackSourceCleanup,
} from "../media/playback-transcode.test-support.js";
import { createManagedArtifactDownload } from "./artifact-download-grants.js";
import {
  assistantMessage,
  authorizeGatewayHttpRequestOrReplyMock,
  bindHttpResponseAuthority,
  handleManagedOutgoingImageHttpRequest,
  mediaMessage,
  mediaPath,
  mockSessionEntry,
  readSessionMessagesMock,
  requestManagedImage,
  resolveOpenAiCompatibleHttpSenderIsOwnerMock,
  resolvePlaybackMetadataForSourceMock,
  resolvePlaybackTranscodeMock,
  resolveSharedSecretHttpOperatorScopesMock,
  useManagedImageState,
} from "./managed-image-attachments.http.test-support.js";
import {
  createFixture,
  createManagedOutgoingImageBlocks,
  expectPathMissing,
  requireAttachmentIdFromUrl,
  requireBlock,
  writeSource,
} from "./managed-image-attachments.test-support.js";
import {
  listManagedImageRecordEntries,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { createSessionFileDownloadClient } from "./server-methods/sessions-files.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const {
  MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload: resolveManagedOutgoingImageArtifactDownload,
} = await import("./managed-image-attachments.js");

function playbackFixture(stateDir: string) {
  return createFixture(stateDir, {
    filename: "voice.caf",
    contentType: "audio/x-caf",
    body: Buffer.from("caff-original"),
  });
}

describe("managed attachment playback", () => {
  let stateDir: string;
  useManagedImageState("managed-media-playback-", (prepared) => {
    stateDir = prepared;
  });

  it("serves a ticketed byte range from managed audio", async () => {
    const body = Buffer.from("original-audio");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "音声%20.mp3",
      contentType: "audio/mpeg",
      body,
    });
    const transcriptMessages = [mediaMessage({ sessionKey, attachmentId }, "audio")];
    mockSessionEntry(path.join(stateDir, "gateway-sessions.json"));
    readSessionMessagesMock.mockResolvedValue(transcriptMessages);
    const preparedSource = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });
    using connection = createSessionFileDownloadClient();
    expect(preparedSource).not.toBeNull();
    const download = createManagedArtifactDownload({
      client: connection.client,
      path: preparedSource!.url,
      assertCurrent() {},
      release() {},
    });
    const clients = new Set([connection.client]);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: download?.url ?? "",
      denyAuth: true,
      clients,
      headers: { range: "bytes=9-13" },
      transcriptMessages,
    });

    expect(preparedSource).toMatchObject({ type: "audio", title: "音声%20.mp3" });
    expect(result.headers["content-disposition"]).toContain(
      "filename*=UTF-8''%E9%9F%B3%E5%A3%B0%2520.mp3",
    );
    expect(result).toMatchObject({
      statusCode: 206,
      headers: { "content-type": "audio/mpeg", "content-range": `bytes 9-13/${body.byteLength}` },
    });
    expect(result.body.toString("utf8")).toBe("audio");
    const wrongAttachmentId = "22222222-2222-4222-8222-222222222222";
    const wrong = await requestManagedImage({
      stateDir,
      pathName: (download?.url ?? "").replace(attachmentId, wrongAttachmentId),
      denyAuth: true,
      clients,
    });
    expect(wrong.result.statusCode).toBe(404);
    expect(authorizeGatewayHttpRequestOrReplyMock).not.toHaveBeenCalled();
  });
  it("returns 202 while a managed playback transcode is preparing", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "preparing" });
    const fixture = await playbackFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `${mediaPath(fixture)}?playback=1`,
      authResponse: { authMethod: "token" },
      scopes: ["operator.admin"],
    });

    expect(result.statusCode).toBe(202);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({ status: "preparing" });
  });
  it("closes the opened managed-media descriptor when playback resolution rejects", async () => {
    const { attachmentId, sessionKey, originalPath } = await playbackFixture(stateDir);
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
            url: `${mediaPath({ sessionKey, attachmentId })}?playback=1`,
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
    const fixture = await playbackFixture(stateDir);
    const requestPlayback = (options: Partial<Parameters<typeof requestManagedImage>[0]> = {}) =>
      requestManagedImage({
        stateDir,
        pathName: `${mediaPath(fixture)}?playback=1`,
        authResponse: { authMethod: "token" },
        ...options,
      });

    const { result } = await requestPlayback({ headers: { range: "bytes=11-15" } });

    expect(result).toMatchObject({
      statusCode: 206,
      headers: {
        "content-type": "audio/mp4",
        "cache-control": "private, no-cache",
        "content-range": `bytes 11-15/${transcoded.byteLength}`,
      },
    });
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["last-modified"]).toBeUndefined();
    expect(result.headers["content-disposition"]).toContain('filename="voice.m4a"');
    expect(result.body.toString("utf8")).toBe("audio");

    for (const method of ["GET", "HEAD"]) {
      resolvePlaybackTranscodeMock.mockResolvedValueOnce(playback);
      const exists = await requestPlayback({
        method,
        headers: { "if-none-match": "*", range: "bytes=11-15" },
      });
      expect(exists.result.statusCode).toBe(304);
      expect(exists.result.headers.etag).toBeUndefined();
      expect(exists.result.headers["content-length"]).toBeUndefined();
      expect(exists.result.body).toHaveLength(0);
    }
  });
  it("publishes managed media while both inspection slots remain occupied and recovers playback", async () => {
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
      const sourceStat = await fs.stat(sourcePath);
      pending.push(
        actual.resolvePlaybackMetadataForSource({
          sourcePath,
          sourceStat: {
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            ctimeMs: sourceStat.ctimeMs,
            exactIdentity: await fs.stat(sourcePath, { bigint: true }),
          },
          mimeType: "audio/mpeg",
          kind: "audio",
        }),
      );
    }
    await entered.promise;
    const onPrepareError = vi.fn();
    const creation = createManagedOutgoingImageBlocks({
      stateDir,
      sessionKey: "agent:main:main",
      mediaUrls: ["data:audio/x-caf;base64,Y2FmZi1vcmlnaW5hbA=="],
      messageId: "msg-1",
      abortSignal: abort.signal,
      continueOnPrepareError: true,
      onPrepareError,
    });
    pending.push(creation);
    const blocks = await creation;
    expect(onPrepareError).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
    const block = requireBlock(blocks);
    expect(block).toMatchObject({ type: "audio", mimeType: "audio/x-caf" });
    expect(block.playback).toBeUndefined();
    expect(
      await readManagedImageRecord(requireAttachmentIdFromUrl(block.url), stateDir),
    ).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);

    release.resolve();
    await Promise.all(pending);
    probe.mockResolvedValue({ durationMs: 1000, audioCodec: "aac", audioStreamIndex: 0 });
    const safeFiles = await import("../infra/fs-safe.js");
    const open = safeFiles.openLocalFileSafely;
    resolvePlaybackTranscodeMock.mockImplementation(async (params) => {
      // HTTP streaming closes its raw handle; only the resolver uses async disposal.
      const openedSources = vi
        .spyOn(safeFiles, "openLocalFileSafely")
        .mockImplementation((...args) => observePlaybackSourceOpen(open(...args)));
      try {
        return await actual.resolvePlaybackTranscode(params);
      } finally {
        openedSources.mockRestore();
      }
    });
    const ffmpeg = await import("../media/ffmpeg-exec.js");
    const rendition = Buffer.from("normalized-m4a-fixture");
    using converter = vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (args) => {
      await fs.writeFile(args.at(-1)!, rendition);
      return "";
    });
    onTestFinished(() => waitForPlaybackSourceCleanup());
    const transcriptMessages = [assistantMessage([block])];
    using connection = createSessionFileDownloadClient();
    const download = createManagedArtifactDownload({
      client: connection.client,
      path: String(block.url),
      assertCurrent() {},
      release() {},
    });
    const request = {
      stateDir,
      pathName: download.url,
      transcriptMessages,
      denyAuth: true,
      clients: new Set([connection.client]),
    };
    const original = await requestManagedImage(request);
    expect(original.result.statusCode).toBe(200);
    expect(original.result.headers["content-type"]).toBe("audio/x-caf");
    expect(original.result.body.toString()).toBe("caff-original");
    expect(converter).not.toHaveBeenCalled();
    const playbackRequest = { ...request, pathName: `${download.url}&playback=1` };
    const preparing = await requestManagedImage(playbackRequest);
    expect(preparing.result.statusCode).toBe(202);
    await waitForPlaybackSourceCleanup();
    const ready = await requestManagedImage(playbackRequest);
    expect(ready.result.statusCode).toBe(200);
    expect(ready.result.headers["content-type"]).toBe("audio/mp4");
    expect(ready.result.body).toEqual(rendition);
  });
  it("returns a visible failure without publishing a record when playback inspection fails", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.mp3");
    await writeSource(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    resolvePlaybackMetadataForSourceMock.mockRejectedValueOnce(
      new Error("synthetic playback inspection failure"),
    );

    const blocks = await createManagedOutgoingImageBlocks({
      stateDir,
      sessionKey: "agent:main:main",
      mediaUrls: [sourcePath],
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
});
