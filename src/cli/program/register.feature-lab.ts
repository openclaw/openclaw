import type { Command } from "commander";
import { featureLabStatusCommand } from "../../commands/feature-lab-status.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerFeatureLabCommand(program: Command) {
  program
    .command("feature-lab")
    .description("Inspect local OpenClaw feature-lab deployment metadata")
    .option("--json", "Output JSON instead of text", false)
    .option("--root <path>", "Feature lab root (default: ~/openclaw-feature-lab)")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await featureLabStatusCommand(
          {
            json: Boolean(opts.json),
            root: opts.root as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
