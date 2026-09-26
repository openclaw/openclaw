import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const runFfprobe = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("../media/ffmpeg-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/ffmpeg-exec.js")>()),
  runFfprobe,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => runFfprobe.mockReset());

async function readMetadata(filePath: string) {
  const { res, end } = makeMockHttpResponse();
  const handled = await handleControlUiAssistantMediaRequest(
    {
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
      method: "GET",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage,
    res,
    { auth: { mode: "token", token: "test-token", allowTailscale: false } },
  );
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(200);
  const payload: unknown = JSON.parse(String(end.mock.calls[0]?.[0] ?? ""));
  return payload;
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

it("marks exotic assistant media metadata for playback transcoding", async () => {
  runFfprobe.mockResolvedValueOnce(
    JSON.stringify({
      format: { duration: "1" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le" }],
    }),
  );
  const root = tempDirs.make("ui-media-transcode-meta-", resolvePreferredOpenClawTmpDir());
  const filePath = path.join(root, "voice.caf");
  await fs.writeFile(filePath, Buffer.from("caff-original"));
  expect(await readMetadata(filePath)).toMatchObject({
    available: true,
    mimeType: "audio/x-caf",
    playback: "transcode",
    durationMs: 1000,
  });
});
