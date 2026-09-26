import { once } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import * as playback from "../media/playback-transcode.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import * as httpAuth from "./http-auth-utils.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const runFfprobe = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("../media/ffmpeg-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/ffmpeg-exec.js")>()),
  runFfprobe,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  runFfprobe.mockReset();
});

function startMediaRequest(filePath: string, mode: "meta" | "playback" = "meta") {
  const response = makeMockHttpResponse();
  const { res } = response;
  res.req.url = `/__openclaw__/assistant-media?${mode}=1&source=${encodeURIComponent(filePath)}&token=test-token`;
  res.req.method = "GET";
  Object.defineProperty(res.req.socket, "remoteAddress", { value: "127.0.0.1" });
  const handled = handleControlUiAssistantMediaRequest(res.req, res, {
    auth: { mode: "token", token: "test-token", allowTailscale: false },
  });
  return { ...response, handled };
}

async function readMetadataResponse({ res, end, handled }: ReturnType<typeof startMediaRequest>) {
  expect(await handled).toBe(true);
  expect(res.statusCode).toBe(200);
  const payload: unknown = JSON.parse(String(end.mock.calls[0]?.[0] ?? ""));
  return payload;
}

async function readMetadata(filePath: string) {
  return await readMetadataResponse(startMediaRequest(filePath));
}

function blockPlaybackProbes(codecName = "pcm_s16le") {
  const started = createDeferred();
  const gate = createDeferred();
  runFfprobe.mockImplementation(async () => {
    if (runFfprobe.mock.calls.length === 2) {
      started.resolve();
    }
    await gate.promise;
    return JSON.stringify({
      format: { duration: "1" },
      streams: [{ index: 0, codec_type: "audio", codec_name: codecName }],
    });
  });
  return { started: started.promise, release: gate.resolve };
}

it("shares audio metadata probes, retries failures, and reinspects replacements", async () => {
  const probe = (duration: string) =>
    JSON.stringify({
      format: { duration },
      streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }],
    });
  runFfprobe.mockRejectedValueOnce(new Error("ffprobe unavailable"));
  runFfprobe.mockResolvedValue(probe("2.345"));
  const root = tempDirs.make("ui-media-audio-meta-", resolvePreferredOpenClawTmpDir());
  const filePath = path.join(root, "voice.mp3");
  const contents = Buffer.from("ID3audio-fixture");
  await fs.writeFile(filePath, contents);
  expect(await readMetadata(filePath)).not.toHaveProperty("durationMs");
  expect(runFfprobe).toHaveBeenCalledOnce();
  for (let batch = 0; batch < 2; batch++) {
    const metadata = await Promise.all(Array.from({ length: 10 }, () => readMetadata(filePath)));
    for (const entry of metadata) {
      expect(entry).toMatchObject({
        available: true,
        mimeType: "audio/mpeg",
        playback: "native",
        sizeBytes: contents.byteLength,
        durationMs: 2345,
      });
    }
    expect(runFfprobe).toHaveBeenCalledTimes(2);
  }

  const original = await fs.stat(filePath);
  const replacement = path.join(root, "replacement.mp3");
  await fs.writeFile(replacement, contents);
  await fs.utimes(replacement, original.atime, original.mtime);
  await fs.rename(replacement, filePath);
  runFfprobe.mockResolvedValue(probe("4.567"));
  expect(await readMetadata(filePath)).toMatchObject({ available: true, durationMs: 4567 });
  expect(runFfprobe).toHaveBeenCalledTimes(3);
  expect(runFfprobe).toHaveBeenCalledWith(expect.any(Array), {
    stdinFileDescriptor: expect.any(Number),
  });
});

it("retains exotic playback metadata while distinct files fill the inspection slots", async () => {
  const probesStarted = createDeferred();
  const probeGate = createDeferred();
  let activeProbes = 0;
  let peakProbes = 0;
  runFfprobe.mockImplementation(async () => {
    peakProbes = Math.max(peakProbes, ++activeProbes);
    if (runFfprobe.mock.calls.length === 2) {
      probesStarted.resolve();
    }
    await probeGate.promise;
    activeProbes--;
    return JSON.stringify({
      format: { duration: "1" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le" }],
    });
  });
  const root = tempDirs.make("ui-media-transcode-meta-", resolvePreferredOpenClawTmpDir());
  const paths = ["first.caf", "second.caf", "third.caf"].map((name) => path.join(root, name));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, Buffer.from("caff-original"))));
  const queuedPath = await fs.realpath(paths[2]!);
  const openedFiles: fsSafe.OpenResult[] = [];
  const openFile = fsSafe.openLocalFileSafely;
  vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
    const opened = await openFile(params);
    openedFiles.push(opened);
    return opened;
  });
  const requests = paths.slice(0, 2).map(readMetadata);
  try {
    await probesStarted.promise;
    const queuedRequestsStarted = createDeferred();
    const resolveMetadata = playback.resolvePlaybackMetadataForSource;
    let queuedRequests = 0;
    vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
      const result = resolveMetadata(params);
      if (++queuedRequests === 2) {
        queuedRequestsStarted.resolve();
      }
      return result;
    });
    requests.push(readMetadata(paths[2]!), readMetadata(paths[2]!));
    await queuedRequestsStarted.promise;
    expect(runFfprobe).toHaveBeenCalledTimes(2);
    for (const opened of openedFiles.filter((entry) => entry.realPath === queuedPath)) {
      expect(opened.handle.fd).toBe(-1);
    }
    probeGate.resolve();
    for (const metadata of await Promise.all(requests)) {
      expect(metadata).toMatchObject({
        available: true,
        mimeType: "audio/x-caf",
        playback: "transcode",
        durationMs: 1000,
      });
    }
    expect(runFfprobe).toHaveBeenCalledTimes(3);
    expect(peakProbes).toBe(2);
  } finally {
    probeGate.resolve();
    await Promise.allSettled(requests);
  }
});

it("bounds pending distinct inspections and returns retryable busy metadata on overflow", async () => {
  const probes = blockPlaybackProbes();
  const root = tempDirs.make("ui-media-burst-meta-", resolvePreferredOpenClawTmpDir());
  const paths = Array.from({ length: 35 }, (_, index) => path.join(root, `${index}.caf`));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, Buffer.from("caff-original"))));
  const requests = paths.slice(0, 2).map((filePath) => startMediaRequest(filePath));
  try {
    await probes.started;
    const queueFull = createDeferred();
    const overflowRequested = createDeferred();
    const resolveMetadata = playback.resolvePlaybackMetadataForSource;
    let queuedRequests = 0;
    vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
      const result = resolveMetadata(params);
      if (++queuedRequests === 32) {
        queueFull.resolve();
      } else if (queuedRequests === 34) {
        overflowRequested.resolve();
      }
      return result;
    });
    requests.push(...paths.slice(2, 34).map((filePath) => startMediaRequest(filePath)));
    await queueFull.promise;
    const shared = startMediaRequest(paths[2]!);
    const overflow = startMediaRequest(paths[34]!);
    requests.push(shared, overflow);
    await overflowRequested.promise;
    expect(runFfprobe).toHaveBeenCalledTimes(2);
    probes.release();
    const metadata = await Promise.all(requests.map(readMetadataResponse));
    expect(metadata.at(-1)).toMatchObject({
      available: false,
      code: "attachment-unavailable",
      retryable: true,
      reason: expect.stringMatching(/busy/i),
    });
    for (const entry of metadata.slice(0, -1)) {
      expect(entry).toMatchObject({ available: true, playback: "transcode", durationMs: 1000 });
    }
    expect(runFfprobe).toHaveBeenCalledTimes(34);
    expect(await readMetadata(paths[34]!)).toMatchObject({
      available: true,
      playback: "transcode",
      durationMs: 1000,
    });
    expect(runFfprobe).toHaveBeenCalledTimes(35);
  } finally {
    probes.release();
    await Promise.allSettled(requests.map(({ handled }) => handled));
  }
});

it("skips abandoned queued inspections while retaining shared and later live requests", async () => {
  const probes = blockPlaybackProbes();
  const root = tempDirs.make("ui-media-aborted-meta-", resolvePreferredOpenClawTmpDir());
  const paths = ["first", "second", "abandoned", "shared", "later"].map((name) =>
    path.join(root, `${name}.caf`),
  );
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, Buffer.from("caff-original"))));
  const requests = paths.slice(0, 2).map((filePath) => startMediaRequest(filePath));
  try {
    await probes.started;
    const queued = createDeferred();
    const resolveMetadata = playback.resolvePlaybackMetadataForSource;
    let queuedRequests = 0;
    vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
      const result = resolveMetadata(params);
      if (++queuedRequests === 4) {
        queued.resolve();
      }
      return result;
    });
    const abandoned = startMediaRequest(paths[2]!);
    const sharedAbandoned = startMediaRequest(paths[3]!);
    const sharedLive = startMediaRequest(paths[3]!);
    const later = startMediaRequest(paths[4]!);
    requests.push(abandoned, sharedAbandoned, sharedLive, later);
    await queued.promise;
    const closed = Promise.all([once(abandoned.res, "close"), once(sharedAbandoned.res, "close")]);
    abandoned.res.destroy();
    sharedAbandoned.res.destroy();
    await closed;
    probes.release();
    for (const request of [...requests.slice(0, 2), sharedLive, later]) {
      expect(await readMetadataResponse(request)).toMatchObject({
        available: true,
        playback: "transcode",
        durationMs: 1000,
      });
    }
    await Promise.all([abandoned.handled, sharedAbandoned.handled]);
    expect(runFfprobe).toHaveBeenCalledTimes(4);
  } finally {
    probes.release();
    await Promise.allSettled(requests.map(({ handled }) => handled));
  }
});

it("skips a disconnected byte-playback inspection and serves later metadata", async () => {
  const probes = blockPlaybackProbes("mp3");
  const root = tempDirs.make("ui-media-aborted-playback-", resolvePreferredOpenClawTmpDir());
  const paths = ["first", "second", "abandoned", "later"].map((name) =>
    path.join(root, `${name}.mp3`),
  );
  await Promise.all(
    paths.map((filePath) => fs.writeFile(filePath, Buffer.from("ID3audio-fixture"))),
  );
  const requests = paths.slice(0, 2).map((filePath) => startMediaRequest(filePath));
  try {
    await probes.started;
    const playbackRequested = createDeferred();
    const resolveTranscode = playback.resolvePlaybackTranscode;
    vi.spyOn(playback, "resolvePlaybackTranscode").mockImplementation((params) => {
      const result = resolveTranscode(params);
      playbackRequested.resolve();
      return result;
    });
    const abandoned = startMediaRequest(paths[2]!, "playback");
    requests.push(abandoned);
    await playbackRequested.promise;
    const metadataQueued = createDeferred();
    const resolveMetadata = playback.resolvePlaybackMetadataForSource;
    vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
      const result = resolveMetadata(params);
      metadataQueued.resolve();
      return result;
    });
    const later = startMediaRequest(paths[3]!);
    requests.push(later);
    await metadataQueued.promise;
    const closed = once(abandoned.res, "close");
    abandoned.res.destroy();
    await closed;
    probes.release();
    for (const request of [...requests.slice(0, 2), later]) {
      expect(await readMetadataResponse(request)).toMatchObject({
        available: true,
        playback: "native",
        durationMs: 1000,
      });
    }
    expect(await abandoned.handled).toBe(true);
    expect(abandoned.end).not.toHaveBeenCalled();
    expect(runFfprobe).toHaveBeenCalledTimes(3);
  } finally {
    probes.release();
    await Promise.allSettled(requests.map(({ handled }) => handled));
  }
});

it("reclaims a full abandoned queue before active inspections finish", async () => {
  const probes = blockPlaybackProbes();
  const root = tempDirs.make("ui-media-reclaimed-meta-", resolvePreferredOpenClawTmpDir());
  const paths = Array.from({ length: 35 }, (_, index) => path.join(root, `${index}.caf`));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, Buffer.from("caff-original"))));
  const requests = paths.slice(0, 2).map((filePath) => startMediaRequest(filePath));
  try {
    await probes.started;
    const queueFull = createDeferred();
    const laterRequested = createDeferred();
    const resolveMetadata = playback.resolvePlaybackMetadataForSource;
    let queuedRequests = 0;
    vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
      const result = resolveMetadata(params);
      if (++queuedRequests === 32) {
        queueFull.resolve();
      } else if (queuedRequests === 33) {
        laterRequested.resolve();
      }
      return result;
    });
    const abandoned = paths.slice(2, 34).map((filePath) => startMediaRequest(filePath));
    requests.push(...abandoned);
    await queueFull.promise;
    const closed = Promise.all(abandoned.map(({ res }) => once(res, "close")));
    for (const { res } of abandoned) {
      res.destroy();
    }
    await closed;
    await Promise.all(abandoned.map(({ handled }) => handled));
    const later = startMediaRequest(paths[34]!);
    requests.push(later);
    await laterRequested.promise;
    expect(runFfprobe).toHaveBeenCalledTimes(2);
    probes.release();
    for (const request of [...requests.slice(0, 2), later]) {
      expect(await readMetadataResponse(request)).toMatchObject({
        available: true,
        playback: "transcode",
        durationMs: 1000,
      });
    }
    expect(runFfprobe).toHaveBeenCalledTimes(3);
  } finally {
    probes.release();
    await Promise.allSettled(requests.map(({ handled }) => handled));
  }
});

it.each(["while queued", "during safe-open"] as const)(
  "rechecks reader authority %s and retains work for an authorized shared viewer",
  async (revocation) => {
    const probes = blockPlaybackProbes();
    const root = tempDirs.make("ui-media-authority-meta-", resolvePreferredOpenClawTmpDir());
    const paths = ["first", "second", "allowed", "revoked", "shared"].map((name) =>
      path.join(root, `${name}.caf`),
    );
    await Promise.all(
      paths.map((filePath) => fs.writeFile(filePath, Buffer.from("caff-original"))),
    );
    const realPaths = await Promise.all(paths.map((filePath) => fs.realpath(filePath)));
    const revokedRequests = new Set<IncomingMessage>();
    const authorize = httpAuth.authorizeControlUiReadRequestOrReply;
    vi.spyOn(httpAuth, "authorizeControlUiReadRequestOrReply").mockImplementation(
      async (params) => {
        const authorized = await authorize(params);
        return authorized
          ? {
              ...authorized,
              hasCurrentClientAuthority: () =>
                !revokedRequests.has(params.req) && authorized.hasCurrentClientAuthority(),
            }
          : authorized;
      },
    );
    const openedFiles: fsSafe.OpenResult[] = [];
    const openFile = fsSafe.openLocalFileSafely;
    let revokeDuringOpen: (() => void) | undefined;
    vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
      const opened = await openFile(params);
      openedFiles.push(opened);
      if (
        opened.realPath === realPaths[3] &&
        openedFiles.filter((entry) => entry.realPath === realPaths[3]).length === 2
      ) {
        revokeDuringOpen?.();
      }
      return opened;
    });
    const requests = realPaths.slice(0, 2).map((filePath) => startMediaRequest(filePath));
    try {
      await probes.started;
      const queued = createDeferred();
      const resolveMetadata = playback.resolvePlaybackMetadataForSource;
      let queuedRequests = 0;
      vi.spyOn(playback, "resolvePlaybackMetadataForSource").mockImplementation((params) => {
        const result = resolveMetadata(params);
        if (++queuedRequests === 4) {
          queued.resolve();
        }
        return result;
      });
      const allowed = startMediaRequest(realPaths[2]!);
      const revoked = startMediaRequest(realPaths[3]!);
      const sharedRevoked = startMediaRequest(realPaths[4]!);
      const sharedAllowed = startMediaRequest(realPaths[4]!);
      requests.push(allowed, revoked, sharedRevoked, sharedAllowed);
      await queued.promise;
      revokedRequests.add(sharedRevoked.res.req);
      const revoke = () => revokedRequests.add(revoked.res.req);
      if (revocation === "while queued") {
        revoke();
      } else {
        revokeDuringOpen = revoke;
      }
      probes.release();
      for (const request of [...requests.slice(0, 2), allowed, sharedAllowed]) {
        expect(await readMetadataResponse(request)).toMatchObject({
          available: true,
          playback: "transcode",
          durationMs: 1000,
        });
      }
      for (const request of [revoked, sharedRevoked]) {
        expect(await request.handled).toBe(true);
        expect(request.res.statusCode).toBe(404);
      }
      expect(openedFiles.filter((entry) => entry.realPath === realPaths[3])).toHaveLength(
        revocation === "while queued" ? 1 : 2,
      );
      expect(runFfprobe).toHaveBeenCalledTimes(4);
      for (const opened of openedFiles) {
        expect(opened.handle.fd).toBe(-1);
      }
    } finally {
      probes.release();
      await Promise.allSettled(requests.map(({ handled }) => handled));
    }
  },
);
