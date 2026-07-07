// Commander registration for Claws local manifest inspection and read-only planning.
import type { Command } from "commander";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type ClawsInspectOptions = {
  json?: boolean;
};

export type ClawsPlanOptions = {
  json?: boolean;
};

export function registerClawsCli(program: Command) {
  const claws = program.command("claws").description("Inspect and plan OpenClaw Claws");

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
    .command("plan")
    .description("Build a read-only claw lifecycle plan")
    .argument("<manifest>", "Path to an openclaw.claw.v1 JSON manifest")
    .option("--json", "Print JSON", false)
    .action(async (manifest: string, opts: ClawsPlanOptions) => {
      const { runClawsPlanCommand } = await import("./claws-cli.runtime.js");
      await runClawsPlanCommand(manifest, opts);
    });

  applyParentDefaultHelpAction(claws);
}
