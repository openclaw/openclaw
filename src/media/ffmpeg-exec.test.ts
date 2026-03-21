import { describe, expect, it, vi } from "vitest";
import {
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  runFfprobe,
  runFfmpeg,
} from "./ffmpeg-exec.js";

function makeEnoentError(binary: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`spawn ${binary} ENOENT`);
  err.code = "ENOENT";
  err.errno = -2;
  err.syscall = `spawn ${binary}`;
  err.path = binary;
  return err;
}

vi.mock("node:child_process", () => {
  let nextError: Error | null = null;
  const execFile = (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: unknown) => void;
    if (nextError) {
      const err = nextError;
      nextError = null;
      cb(err);
    } else {
      cb(null, { stdout: Buffer.from(""), stderr: Buffer.from("") });
    }
  };
  (execFile as { __setNextError?: (e: Error) => void }).__setNextError = (e: Error) => {
    nextError = e;
  };
  return { execFile };
});

async function setNextExecError(err: Error) {
  const { execFile } = await import("node:child_process");
  (execFile as unknown as { __setNextError: (e: Error) => void }).__setNextError(err);
}

describe("runFfprobe ENOENT handling", () => {
  it("throws a human-readable error when ffprobe is not installed", async () => {
    await setNextExecError(makeEnoentError("ffprobe"));
    await expect(runFfprobe(["-v", "error"])).rejects.toThrow(/ffprobe is not installed/);
  });

  it("preserves the original ENOENT error as cause", async () => {
    await setNextExecError(makeEnoentError("ffprobe"));
    try {
      await runFfprobe(["-v", "error"]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("runFfmpeg ENOENT handling", () => {
  it("throws a human-readable error when ffmpeg is not installed", async () => {
    await setNextExecError(makeEnoentError("ffmpeg"));
    await expect(runFfmpeg(["-y", "-i", "test.ogg"])).rejects.toThrow(/ffmpeg is not installed/);
  });
});

describe("parseFfprobeCsvFields", () => {
  it("splits ffprobe csv output across commas and newlines", () => {
    expect(parseFfprobeCsvFields("opus,\n48000\n", 2)).toEqual(["opus", "48000"]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  it("parses opus codec and numeric sample rate", () => {
    expect(parseFfprobeCodecAndSampleRate("Opus,48000\n")).toEqual({
      codec: "opus",
      sampleRateHz: 48_000,
    });
  });

  it("returns null sample rate for invalid numeric fields", () => {
    expect(parseFfprobeCodecAndSampleRate("opus,not-a-number")).toEqual({
      codec: "opus",
      sampleRateHz: null,
    });
  });
});
