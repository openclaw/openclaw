import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import { videoGenerateCommand } from "./video-generate.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn().mockReturnValue({}),
  generateVideo: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

function createMockRuntime(): OutputRuntimeEnv & {
  output: string[];
  jsonOutput: unknown[];
  exitCode: number | null;
} {
  const output: string[] = [];
  const jsonOutput: unknown[] = [];
  let exitCode: number | null = null;
  return {
    output,
    jsonOutput,
    get exitCode() {
      return exitCode;
    },
    log: (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      output.push(`ERROR: ${args.map(String).join(" ")}`);
    },
    exit: ((code: number) => {
      exitCode = code;
    }) as unknown as (code: number) => never,
    writeStdout: (value: string) => {
      output.push(value);
    },
    writeJson: (value: unknown) => {
      jsonOutput.push(value);
    },
  };
}

function makeSuccessResult() {
  return {
    videos: [{ buffer: Buffer.from("fake-video"), mimeType: "video/mp4" }],
    provider: "google",
    model: "veo-3",
    attempts: [],
    ignoredOverrides: [],
  };
}

describe("videoGenerateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateVideo with prompt and model", async () => {
    mocks.generateVideo.mockResolvedValue(makeSuccessResult());

    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "a sunset", model: "google/veo-3" }, runtime);

    expect(mocks.generateVideo).toHaveBeenCalledTimes(1);
    expect(mocks.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a sunset",
        modelOverride: "google/veo-3",
      }),
    );
  });

  it("writes video to output file", async () => {
    mocks.generateVideo.mockResolvedValue(makeSuccessResult());

    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "test", output: "/tmp/test-out.mp4" }, runtime);

    expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/test-out.mp4", expect.any(Buffer));
  });

  it("validates image count <= 5", async () => {
    const runtime = createMockRuntime();
    await videoGenerateCommand(
      { prompt: "test", image: ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg"] },
      runtime,
    );

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("Too many reference images"))).toBe(true);
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it("validates video count <= 4", async () => {
    const runtime = createMockRuntime();
    await videoGenerateCommand(
      { prompt: "test", video: ["1.mp4", "2.mp4", "3.mp4", "4.mp4", "5.mp4"] },
      runtime,
    );

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("Too many reference videos"))).toBe(true);
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it("validates aspect ratio", async () => {
    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "test", aspectRatio: "7:3" }, runtime);

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("Invalid aspect ratio"))).toBe(true);
  });

  it("validates resolution", async () => {
    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "test", resolution: "4K" }, runtime);

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("Invalid resolution"))).toBe(true);
  });

  it("outputs JSON when --json flag is set", async () => {
    mocks.generateVideo.mockResolvedValue(makeSuccessResult());

    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "test", json: true }, runtime);

    expect(runtime.jsonOutput).toHaveLength(1);
    const result = runtime.jsonOutput[0] as { provider: string; model: string };
    expect(result.provider).toBe("google");
    expect(result.model).toBe("veo-3");
  });

  it("logs ignored overrides as warnings", async () => {
    mocks.generateVideo.mockResolvedValue({
      ...makeSuccessResult(),
      ignoredOverrides: [{ key: "audio", value: true }],
    });

    const runtime = createMockRuntime();
    await videoGenerateCommand({ prompt: "test" }, runtime);

    expect(runtime.output.some((line) => line.includes("Warning") && line.includes("audio"))).toBe(
      true,
    );
  });

  it("passes style options through to generateVideo", async () => {
    mocks.generateVideo.mockResolvedValue(makeSuccessResult());

    const runtime = createMockRuntime();
    await videoGenerateCommand(
      {
        prompt: "test",
        aspectRatio: "16:9",
        resolution: "1080P",
        duration: 8,
        audio: true,
        watermark: true,
      },
      runtime,
    );

    expect(mocks.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
        resolution: "1080P",
        durationSeconds: 8,
        audio: true,
        watermark: true,
      }),
    );
  });
});
