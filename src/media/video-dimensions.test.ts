// Video dimension tests cover ffprobe parsing and fallback behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeVideoDimensions } from "./video-dimensions.js";

const { runFfprobe, withTempWorkspace, resolvePreferredOpenClawTmpDir } = vi.hoisted(() => ({
  runFfprobe: vi.fn(),
  withTempWorkspace: vi.fn(),
  resolvePreferredOpenClawTmpDir: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfprobe,
}));

vi.mock("../infra/private-temp-workspace.js", () => ({
  withTempWorkspace,
}));

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir,
}));

beforeEach(() => {
  resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  withTempWorkspace.mockImplementation(async (_opts, run) => {
    const workspace = {
      write: vi.fn(async (name: string) => `/tmp/openclaw/ws/${name}`),
    };
    return await run(workspace);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("probeVideoDimensions", () => {
  it("writes buffer to seekable temp file then probes path", async () => {
    const buffer = Buffer.from("video");
    const write = vi.fn(async (name: string) => `/tmp/openclaw/ws/${name}`);
    withTempWorkspace.mockImplementationOnce(async (_opts, run) => await run({ write }));
    runFfprobe.mockResolvedValueOnce(JSON.stringify({ streams: [{ width: 720, height: 1280 }] }));

    await expect(probeVideoDimensions(buffer)).resolves.toEqual({ width: 720, height: 1280 });

    expect(write).toHaveBeenCalledWith("video.bin", buffer);
    expect(withTempWorkspace).toHaveBeenCalledWith(
      {
        rootDir: "/tmp/openclaw",
        prefix: "openclaw-ffprobe-",
      },
      expect.any(Function),
    );
    expect(runFfprobe).toHaveBeenCalledWith([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "/tmp/openclaw/ws/video.bin",
    ]);
  });

  it("falls back when ffprobe fails or returns malformed output", async () => {
    const buffer = Buffer.from("video");

    runFfprobe.mockRejectedValueOnce(new Error("missing ffprobe"));
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();

    runFfprobe.mockResolvedValueOnce("{");
    await expect(probeVideoDimensions(buffer)).resolves.toBeUndefined();
  });

  it("falls back when the temp workspace write rejects", async () => {
    withTempWorkspace.mockRejectedValueOnce(new Error("disk full"));
    await expect(probeVideoDimensions(Buffer.from("video"))).resolves.toBeUndefined();
  });
});
