// Commander registration for Claw authoring, inspection, and Add.
import type { Command } from "commander";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type ClawsInspectOptions = {
  json?: boolean;
};

export type ClawsCreateOptions = ClawsInspectOptions & {
  name?: string;
  agentId?: string;
};
export type ClawsValidateOptions = { json?: boolean };
export type ClawsBuildOptions = { out: string; json?: boolean };
export type ClawsDevOptions = { agentId?: string; workspace?: string; json?: boolean };

export type ClawsAddOptions = ClawsDevOptions & {
  dryRun?: boolean;
  acceptCapabilities?: boolean;
  acknowledgeClawhubRisk?: boolean;
};
export function registerClawsCli(program: Command) {
  const claws = program.command("claws").description("Author and add OpenClaw Claws");

  claws
    .command("create")
    .description("Create a minimal local Claw project")
    .argument("[path]", "New project directory", ".")
    .option("--name <name>", "Set the package name")
    .option("--agent-id <id>", "Set the portable agent id")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: ClawsCreateOptions) => {
      const { runClawsCreateCommand } = await import("./claws-cli.project.js");
      await runClawsCreateCommand(path, opts);
    });

  claws
    .command("validate")
    .description("Validate a local Claw project")
    .argument("[path]", "Project directory", ".")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: ClawsValidateOptions) => {
      const { runClawsValidateCommand } = await import("./claws-cli.project.js");
      await runClawsValidateCommand(path, opts);
    });

  claws
    .command("dev")
    .description("Build and preview a local Claw without network or mutation")
    .argument("[path]", "Project directory", ".")
    .option("--agent-id <id>", "Preview with an unused local agent id")
    .option("--workspace <path>", "Preview with a new workspace path")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: ClawsDevOptions) => {
      const { runClawsDevCommand } = await import("./claws-cli.project.js");
      await runClawsDevCommand(path, opts);
    });

  claws
    .command("build")
    .description("Build a reproducible Claw package artifact")
    .argument("[path]", "Project directory", ".")
    .requiredOption("--out <artifact>", "New .tgz artifact to create")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: ClawsBuildOptions) => {
      const { runClawsBuildCommand } = await import("./claws-cli.project.js");
      await runClawsBuildCommand(path, opts);
    });

  claws
    .command("inspect")
    .description("Validate a Claw package or local development manifest")
    .argument("<source>", "Path to a Claw package directory or grouped manifest")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: ClawsInspectOptions) => {
      const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsInspectCommand(source, opts);
    });

  claws
    .command("add")
    .description("Add a new agent and its requirements from a Claw")
    .argument("<source>", "Path to a Claw package directory or grouped manifest")
    .option("--dry-run", "Preview all actions without mutating state", false)
    .option("--accept-capabilities", "Accept required plugin capabilities", false)
    .option("--acknowledge-clawhub-risk", "Acknowledge ClawHub trust warnings", false)
    .option("--agent-id <id>", "Override the requested id with an unused local agent id")
    .option("--workspace <path>", "Override the derived new workspace path")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: ClawsAddOptions) => {
      const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
      await runClawsAddCommand(source, opts);
    });

  applyParentDefaultHelpAction(claws);
}
