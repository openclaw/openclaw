// Commander registration for Claws inspection and dry-run apply previews.
import type { Command } from "commander";
import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type ClawsInspectOptions = {
  json?: boolean;
};

export type ClawsApplyOptions = {
  dryRun?: boolean;
  json?: boolean;
};

export type ClawsFeedInspectOptions = {
  json?: boolean;
};

export type ClawsFeedApplyOptions = {
  dryRun?: boolean;
  json?: boolean;
};

export function registerClawsCli(program: Command) {
  if (!isExperimentalClawsEnabled()) {
    return;
  }
  const claws = program.command("claws").description("Inspect and preview OpenClaw Claws");

  claws
    .command("inspect")
    .description("Validate and summarize a local claw manifest")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsInspectOptions) => {
      const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsInspectCommand(manifest, opts);
    });

  claws
    .command("apply")
    .description("Preview the Claw apply lifecycle without mutating state")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsApplyOptions) => {
      const { runClawsApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsApplyCommand(manifest, opts);
    });

  const feed = claws.command("feed").description("Inspect and preview Claws from a local feed");

  feed
    .command("inspect")
    .description("Validate and summarize a local claw feed")
    .argument("<feed>", "Path to an openclaw.clawFeed.v1 JSON feed")
    .option("--json", "Print JSON", false)
    .action(async (feedPath: string, opts: ClawsFeedInspectOptions) => {
      const { runClawsFeedInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsFeedInspectCommand(feedPath, opts);
    });

  feed
    .command("apply")
    .description("Preview a feed Claw apply lifecycle without mutating state")
    .argument("<feed>", "Path to an openclaw.clawFeed.v1 JSON feed")
    .argument("<claw>", "Claw feed entry id")
    .option("--dry-run", "Preview apply actions without installing or writing files", false)
    .option("--json", "Print JSON", false)
    .action(async (feedPath: string, claw: string, opts: ClawsFeedApplyOptions) => {
      const { runClawsFeedApplyCommand } = await import("./claws-cli.runtime.js");
      await runClawsFeedApplyCommand(feedPath, claw, opts);
    });

  applyParentDefaultHelpAction(feed);

  applyParentDefaultHelpAction(claws);
}
