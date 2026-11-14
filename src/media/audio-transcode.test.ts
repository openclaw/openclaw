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

function pcmWav(): Buffer {
  const b = Buffer.alloc(48);
  b.write("RIFF");
  b.writeUInt32LE(40, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(4, 40);
  return b;
}

it("returns failure without throwing or invoking afconvert when FFmpeg is missing, and cleans up", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let dir = "";
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    dir = path.dirname(args.at(-1)!);
    throw new Error("ffmpeg not found in trusted system directories");
  });
  await expect(
    transcodeAudioBuffer({
      audioBuffer: Buffer.from("mp3"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    }),
  ).resolves.toMatchObject({ ok: false, reason: "transcoder-failed" });
  expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  expect(dir).not.toBe("");
  expect(existsSync(dir)).toBe(false);
});

it.each([false, true])(
  "shares one budget across decode, encode and probe (exhaust=%s), and cleans up",
  async (exhaust) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    let dir = "";
    runFfmpegMock.mockImplementation(async (args: string[], opts: { timeoutMs: number }) => {
      budgets.push(opts.timeoutMs);
      dir = path.dirname(args.at(-1)!);
      await writeFile(args.at(-1)!, pcmWav());
      now += 3000;
    });
    runCommandWithTimeoutMock.mockImplementation(
      async (args: string[], opts: { timeoutMs: number }) => {
        budgets.push(opts.timeoutMs);
        if (args[0] === "/usr/bin/afconvert") {
          expect(args.at(-2)).toBe(path.join(dir, "decoded.wav"));
          await writeFile(args.at(-1)!, Buffer.from("caf"));
          now += exhaust ? 2100 : 1000;
        } else {
          expect(args[0]).toBe("/usr/bin/afinfo");
        }
        return { code: 0, stdout: "Data format: 1 ch, 24000 Hz\naudio 2 valid frames", stderr: "" };
      },
    );
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("mp3"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    });
    expect(result.ok).toBe(!exhaust);
    expect(budgets).toEqual(exhaust ? [5000, 2000] : [5000, 2000, 1000]);
    expect(existsSync(dir)).toBe(false);
  },
);

it.each([
  "signature-high-bit",
  "fmt-high-bit",
  "data-high-bit",
  "duplicate-fmt",
  "duplicate-data",
  "missing-fmt",
  "missing-data",
])("rejects malformed decoder WAV: %s", async (kind) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let dir = "";
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    let b = pcmWav();
    if (kind.endsWith("high-bit")) {
      const offset = kind.startsWith("signature") ? 0 : kind.startsWith("fmt") ? 12 : 36;
      b.writeUInt8(b.readUInt8(offset) | 128, offset);
    } else if (kind.startsWith("duplicate")) {
      b = Buffer.concat([b, kind.endsWith("fmt") ? b.subarray(12, 36) : b.subarray(36)]);
    } else {
      b = Buffer.concat([
        b.subarray(0, 12),
        kind.endsWith("fmt") ? b.subarray(36) : b.subarray(12, 36),
      ]);
    }
    b.writeUInt32LE(b.length - 8, 4);
    dir = path.dirname(args.at(-1)!);
    await writeFile(args.at(-1)!, b);
  });
  await expect(
    transcodeAudioBuffer({
      audioBuffer: Buffer.from("mp3"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    }),
  ).resolves.toMatchObject({
    ok: false,
    reason: "transcoder-failed",
    detail: "invalid decoded PCM WAV header",
  });
  expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  expect(existsSync(dir)).toBe(false);
});

it.each(["encoder-exit", "encoder-timeout", "probe-mismatch", "probe-timeout"])(
  "falls back and removes all staged files on %s",
  async (failure) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let dir = "";
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      dir = path.dirname(args.at(-1)!);
      await writeFile(args.at(-1)!, pcmWav());
    });
    runCommandWithTimeoutMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "/usr/bin/afconvert") {
        await writeFile(args.at(-1)!, Buffer.from("partial caf"));
        return {
          code: failure === "encoder-exit" ? 1 : 0,
          stdout: "",
          stderr: "",
          termination: failure === "encoder-timeout" ? "timeout" : "exit",
        };
      }
      return {
        code: 0,
        stdout: `Data format: 1 ch, 24000 Hz\naudio ${failure === "probe-mismatch" ? 99 : 2} valid frames`,
        stderr: "",
        termination: failure === "probe-timeout" ? "timeout" : "exit",
      };
    });
    await expect(
      transcodeAudioBuffer({
        audioBuffer: Buffer.from("mp3"),
        sourceExtension: "mp3",
        targetExtension: "caf",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "transcoder-failed",
    });
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
  },
);

it("preserves the direct afconvert recipe for non-MP3 input", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let dir = "";
  runCommandWithTimeoutMock.mockImplementation(async (args: string[]) => {
    expect(args[0]).toBe("/usr/bin/afconvert");
    expect(path.basename(args.at(-2)!)).toBe("in.wav");
    dir = path.dirname(args.at(-1)!);
    await writeFile(args.at(-1)!, Buffer.from("caf"));
    return { code: 0, stdout: "", stderr: "" };
  });
  await expect(
    transcodeAudioBuffer({
      audioBuffer: Buffer.from("wav"),
      sourceExtension: "wav",
      targetExtension: "caf",
    }),
  ).resolves.toEqual({
    ok: true,
    buffer: Buffer.from("caf"),
  });
  expect(runFfmpegMock).not.toHaveBeenCalled();
  expect(runCommandWithTimeoutMock).toHaveBeenCalledOnce();
  expect(existsSync(dir)).toBe(false);
});
