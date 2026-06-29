// Video dimension tests cover ffprobe parsing and fallback behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFfprobeVideoDimensions, probeVideoDimensions } from "./video-dimensions.js";

const { runFfprobe, open, unlink, resolvePreferredOpenClawTmpDir } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
  open: vi.fn(),
  unlink: vi.fn(),
  resolvePreferredOpenClawTmpDir: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

vi.mock("node:fs/promises", () => ({
  open,
  unlink,
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir,
}));

const handle = {
  writeFile: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

afterEach(() => {
  vi.clearAllMocks();
  handle.writeFile.mockResolvedValue(undefined);
  handle.close.mockResolvedValue(undefined);
  resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
});

describe("parseFfprobeVideoDimensions", () => {
  it("returns positive integer dimensions from ffprobe JSON", () => {
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 720, height: 1280 }] })),
    ).toEqual({ width: 720, height: 1280 });
  });

  it("ignores missing or invalid dimensions", () => {
    expect(parseFfprobeVideoDimensions(JSON.stringify({ streams: [] }))).toBeUndefined();
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 0, height: 1280 }] })),
    ).toBeUndefined();
    expect(
      parseFfprobeVideoDimensions(JSON.stringify({ streams: [{ width: 720.5, height: 1280 }] })),
    ).toBeUndefined();
  });
});

describe("probeVideoDimensions", () => {
  it("writes buffer to seekable temp file then probes path", async () => {
    const buffer = Buffer.from("video");
    open.mockResolvedValueOnce(handle);
    unlink.mockResolvedValueOnce(undefined);
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ streams: [{ width: 720, height: 1280 }] }));

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 720, height: 1280 });

    expect(open).toHaveBeenCalledTimes(1);
    const tempPath = open.mock.calls[0][0];
    expect(tempPath).toContain("openclaw-ffprobe-");
    expect(tempPath).toContain(".bin");
    expect(handle.writeFile).toHaveBeenCalledWith(buffer);
    expect(runFfprobe).toHaveBeenCalledWith([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      tempPath,
    ]);
    expect(unlink).toHaveBeenCalledWith(tempPath);
  });

  it("falls back when ffprobe fails or returns malformed output", async () => {
    const buffer = Buffer.from("video");
    open.mockResolvedValue(handle);
    unlink.mockResolvedValue(undefined);

    runFfprobe.mockRejectedValueOnce(new Error("missing ffprobe"));
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();

    runFfprobe.mockResolvedValueOnce("{");
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
  });

  it("still unlinks the temp file when ffprobe rejects", async () => {
    const buffer = Buffer.from("video");
    open.mockResolvedValueOnce(handle);
    unlink.mockResolvedValueOnce(undefined);
    runFfprobe.mockRejectedValueOnce(new Error("boom"));

    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("unlinks the temp file when the write itself rejects", async () => {
    const buffer = Buffer.from("video");
    open.mockResolvedValueOnce(handle);
    unlink.mockResolvedValueOnce(undefined);
    handle.writeFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
    expect(handle.close).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});
