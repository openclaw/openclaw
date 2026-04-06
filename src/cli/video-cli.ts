import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

function runVideoCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function registerVideoCli(program: Command) {
  const video = program.command("video").description("Video generation commands");

  video
    .command("generate")
    .description("Generate a video from a text prompt")
    .requiredOption("--prompt <text>", "Text description of video to generate")
    .option("--model <provider/model>", "Provider and model override (e.g. google/veo-3)")
    .option("--image <path...>", "Reference image path(s), max 5")
    .option("--video <path...>", "Reference video path(s), max 4")
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 16:9, 9:16, 1:1)")
    .option("--resolution <res>", "Resolution: 480P, 720P, 1080P")
    .option("--duration <seconds>", "Duration in seconds", parseFloat)
    .option("--audio", "Enable audio generation")
    .option("--watermark", "Enable watermark")
    .option("--output <path>", "Output file path (default: auto-named in cwd)")
    .option("--json", "Output result as JSON")
    .action(async (opts) => {
      await runVideoCommand(async () => {
        const { videoGenerateCommand } = await import("../commands/video-generate.js");
        await videoGenerateCommand(
          {
            prompt: opts.prompt as string,
            model: opts.model as string | undefined,
            image: opts.image as string[] | undefined,
            video: opts.video as string[] | undefined,
            aspectRatio: opts.aspectRatio as string | undefined,
            resolution: opts.resolution as string | undefined,
            duration: opts.duration as number | undefined,
            audio: opts.audio === true ? true : undefined,
            watermark: opts.watermark === true ? true : undefined,
            output: opts.output as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  video
    .command("list")
    .description("List available video generation providers and models")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runVideoCommand(async () => {
        const { videoListCommand } = await import("../commands/video-list.js");
        await videoListCommand({ json: Boolean(opts.json) }, defaultRuntime);
      });
    });
}
