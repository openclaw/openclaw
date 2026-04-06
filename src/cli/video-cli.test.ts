import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerVideoCli } from "./video-cli.js";

const mocks = vi.hoisted(() => ({
  videoGenerateCommand: vi.fn().mockResolvedValue(undefined),
  videoListCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/video-generate.js", () => ({
  videoGenerateCommand: mocks.videoGenerateCommand,
}));

vi.mock("../commands/video-list.js", () => ({
  videoListCommand: mocks.videoListCommand,
}));

describe("video cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createProgram() {
    const program = new Command();
    registerVideoCli(program);
    return program;
  }

  it("registers video command with generate and list subcommands", () => {
    const program = createProgram();
    const video = program.commands.find((c) => c.name() === "video");
    expect(video).toBeDefined();
    const subNames = video!.commands.map((c) => c.name());
    expect(subNames).toContain("generate");
    expect(subNames).toContain("list");
  });

  it("passes generate options through to videoGenerateCommand", async () => {
    await runRegisteredCli({
      register: registerVideoCli as (program: Command) => void,
      argv: [
        "video",
        "generate",
        "--prompt",
        "a sunset over the ocean",
        "--model",
        "google/veo-3",
        "--aspect-ratio",
        "16:9",
        "--resolution",
        "1080P",
        "--duration",
        "8",
        "--audio",
        "--output",
        "./out.mp4",
        "--json",
      ],
    });

    expect(mocks.videoGenerateCommand).toHaveBeenCalledTimes(1);
    expect(mocks.videoGenerateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a sunset over the ocean",
        model: "google/veo-3",
        aspectRatio: "16:9",
        resolution: "1080P",
        duration: 8,
        audio: true,
        output: "./out.mp4",
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("passes list --json option through to videoListCommand", async () => {
    await runRegisteredCli({
      register: registerVideoCli as (program: Command) => void,
      argv: ["video", "list", "--json"],
    });

    expect(mocks.videoListCommand).toHaveBeenCalledTimes(1);
    expect(mocks.videoListCommand).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
      expect.any(Object),
    );
  });
});
