import syncFs, { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { transcodeAudioBuffer, transcodeAudioBufferToOpus } from "./audio-transcode.js";

const runFfmpegMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("./ffmpeg-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ffmpeg-exec.js")>()),
  runFfmpeg: runFfmpegMock,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));
afterEach(() => {
  vi.restoreAllMocks();
  runCommandWithTimeoutMock.mockReset();
  runFfmpegMock.mockReset();
});

type OpusOptions = Omit<Parameters<typeof transcodeAudioBufferToOpus>[0], "audioBuffer">;
it.each<[OpusOptions, string, string]>([
  [{ inputExtension: "mp3", tempPrefix: "tts-test-", timeoutMs: 1234 }, "input.mp3", "voice.opus"],
  [
    {
      inputExtension: "../bad",
      outputFileName: "../escape.opus",
      tempPrefix: "../bad-prefix",
      maxDurationSeconds: 300,
    },
    "input.audio",
    "escape.opus",
  ],
  [
    { inputFileName: "voice.wav", outputFileName: String.raw`C:\Users\Ada\Downloads\reply.opus` },
    "input.wav",
    "reply.opus",
  ],
])("stages, transcodes and cleans up: %j", async (options, input, output) => {
  let inputPath = "";
  let outputPath = "";
  runFfmpegMock.mockImplementationOnce(
    async (args: string[], execution: { timeoutMs?: number }) => {
      inputPath = args[args.indexOf("-i") + 1] ?? "";
      outputPath = args.at(-1) ?? "";
      expect(path.basename(inputPath)).toBe(input);
      expect(path.basename(outputPath)).toContain(output);
      expect(path.basename(outputPath)).toMatch(/\.part$/);
      const command = args.join(" ");
      expect(command).toContain("-c:a libopus -b:a 64k -ar 48000 -ac 1 -f opus");
      expect(args.includes("-t")).toBe(options.maxDurationSeconds !== undefined);
      if (options.maxDurationSeconds !== undefined) {
        expect(command).toContain(`-t ${options.maxDurationSeconds}`);
      }
      expect(execution.timeoutMs).toBe(options.timeoutMs);
      await expect(readFile(inputPath)).resolves.toEqual(Buffer.from("source-mp3"));
      await writeFile(outputPath, Buffer.from("opus-output"));
    },
  );
  await expect(
    transcodeAudioBufferToOpus({ audioBuffer: Buffer.from("source-mp3"), ...options }),
  ).resolves.toEqual(Buffer.from("opus-output"));
  const tempRoot = realpathSync(resolvePreferredOpenClawTmpDir());
  const prefix = options.tempPrefix === "tts-test-" ? options.tempPrefix : "";
  expect(inputPath.startsWith(path.join(tempRoot, prefix))).toBe(true);
  expect([existsSync(inputPath), existsSync(outputPath)]).toEqual([false, false]);
});

it.each([0, Number.POSITIVE_INFINITY])(
  "rejects invalid maximum duration %s before ffmpeg",
  async (maxDurationSeconds) => {
    await expect(
      transcodeAudioBufferToOpus({ audioBuffer: Buffer.from("source"), maxDurationSeconds }),
    ).rejects.toThrow("maxDurationSeconds must be a positive finite number");
    expect(runFfmpegMock).not.toHaveBeenCalled();
  },
);
it("returns a failure and cleans its workspace when input staging fails", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let workspaceDir: string | undefined;
  const lstat = syncFs.lstatSync;
  vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
    const [filePath] = args;
    if (typeof filePath === "string" && path.basename(filePath) === "in.mp3") {
      workspaceDir = path.dirname(filePath);
      throw Object.assign(new Error("input exceeds bounded staging limit"), { code: "EFBIG" });
    }
    return lstat(...args);
  });

  const result = await transcodeAudioBuffer({
    audioBuffer: Buffer.from("payload"),
    sourceExtension: "mp3",
    targetExtension: "caf",
  });

  expect(result).toEqual({
    ok: false,
    reason: "transcoder-failed",
    detail: "input exceeds bounded staging limit",
  });
  expect(workspaceDir).toBeDefined();
  expect(workspaceDir ? existsSync(workspaceDir) : true).toBe(false);
  expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
});

it.each([
  ["mp3", ".mp3", "noop-same-container"],
  ["mp3", "flac", "no-recipe"],
  ["", "caf", "invalid-extension"],
  ["mp3", "", "invalid-extension"],
  ["../etc/passwd", "caf", "invalid-extension"],
  ["mp3", "caf", "platform-unsupported"],
])("converting %j to %j returns %s", async (sourceExtension, targetExtension, reason) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const result = await transcodeAudioBuffer({
    audioBuffer: Buffer.from("payload"),
    sourceExtension,
    targetExtension,
  });
  expect(result).toEqual({ ok: false, reason });
  expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
});
