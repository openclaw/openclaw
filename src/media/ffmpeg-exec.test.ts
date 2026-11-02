import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { runExecMock, resolveSystemBinMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  resolveSystemBinMock: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: runExecMock,
}));

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: resolveSystemBinMock,
}));

let parseFfprobeCodecAndSampleRate: typeof import("./ffmpeg-exec.js").parseFfprobeCodecAndSampleRate;
let resolveFfmpegBin: typeof import("./ffmpeg-exec.js").resolveFfmpegBin;
let runFfprobe: typeof import("./ffmpeg-exec.js").runFfprobe;

beforeAll(async () => {
  vi.resetModules();
  ({ parseFfprobeCodecAndSampleRate, resolveFfmpegBin, runFfprobe } =
    await import("./ffmpeg-exec.js"));
});

afterAll(() => {
  vi.doUnmock("../process/exec.js");
  vi.doUnmock("../infra/resolve-system-bin.js");
  vi.resetModules();
});

beforeEach(() => {
  runExecMock.mockReset();
  resolveSystemBinMock.mockReset().mockReturnValue("/usr/bin/ffprobe");
});

describe("parseFfprobeCodecAndSampleRate", () => {
  it.each([
    ["Opus,48000\n", 48_000],
    ["opus,not-a-number", null],
    ["opus,48000hz", null],
    ["opus,", null],
    ["opus,0", null],
    ["opus,-48000", null],
  ] as const)("parses codec and sample rate from %j", (input, sampleRateHz) => {
    expect(parseFfprobeCodecAndSampleRate(input)).toEqual({ codec: "opus", sampleRateHz });
  });
});

describe("runFfprobe", () => {
  it("passes stdin and limits through the canonical exec wrapper", async () => {
    const input = Buffer.from("audio");
    runExecMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    await expect(
      runFfprobe(["pipe:0"], { input, timeoutMs: 1234, maxBufferBytes: 5678 }),
    ).resolves.toBe("ok");

    expect(runExecMock).toHaveBeenCalledWith("/usr/bin/ffprobe", ["pipe:0"], {
      input,
      logOutput: false,
      maxBuffer: 5678,
      timeoutMs: 1234,
    });
  });

  it("passes an inherited file descriptor through the canonical exec wrapper", async () => {
    runExecMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    await expect(runFfprobe(["pipe:0"], { stdinFileDescriptor: 17 })).resolves.toBe("ok");
    expect(runExecMock).toHaveBeenCalledWith("/usr/bin/ffprobe", ["pipe:0"], {
      logOutput: false,
      maxBuffer: 10 * 1024 * 1024,
      stdinFileDescriptor: 17,
      timeoutMs: 10_000,
    });
  });

  it("preserves wrapper execution errors", async () => {
    const childError = new Error("ffprobe failed");
    runExecMock.mockRejectedValue(childError);

    await expect(runFfprobe(["pipe:0"], { input: Buffer.from("audio") })).rejects.toBe(childError);
  });
});

describe("resolveFfmpegBin", () => {
  it("resolves ffmpeg from trusted system paths", () => {
    resolveSystemBinMock.mockReturnValue("/usr/bin/ffmpeg");

    expect(resolveFfmpegBin()).toBe("/usr/bin/ffmpeg");
    expect(resolveSystemBinMock).toHaveBeenCalledWith("ffmpeg", { trust: "standard" });
  });
});
