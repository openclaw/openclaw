import type { Command } from "commander";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type TemplatesInspectOptions = {
  json?: boolean;
};

export type TemplatesCreateOptions = TemplatesInspectOptions & {
  name?: string;
  agentId?: string;
};
export type TemplatesValidateOptions = { json?: boolean };
export type TemplatesBuildOptions = { out: string; json?: boolean };
export type TemplatesDevOptions = { agentId?: string; workspace?: string; json?: boolean };

export type TemplatesAddOptions = TemplatesDevOptions & {
  dryRun?: boolean;
  acceptCapabilities?: boolean;
  acknowledgeClawhubRisk?: boolean;
};
export function registerTemplatesCli(program: Command) {
  const templates = program.command("templates").description("Author and add OpenClaw Templates");

  templates
    .command("create")
    .description("Create a minimal local Template project")
    .argument("[path]", "New project directory", ".")
    .option("--name <name>", "Set the package name")
    .option("--agent-id <id>", "Set the portable agent id")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: TemplatesCreateOptions) => {
      const { runTemplatesCreateCommand } = await import("./templates-cli.project.js");
      await runTemplatesCreateCommand(path, opts);
    });

  templates
    .command("validate")
    .description("Validate a local Template project")
    .argument("[path]", "Project directory", ".")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: TemplatesValidateOptions) => {
      const { runTemplatesValidateCommand } = await import("./templates-cli.project.js");
      await runTemplatesValidateCommand(path, opts);
    });

  templates
    .command("dev")
    .description("Build and preview a local Template without network or mutation")
    .argument("[path]", "Project directory", ".")
    .option("--agent-id <id>", "Preview with an unused local agent id")
    .option("--workspace <path>", "Preview with a new workspace path")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: TemplatesDevOptions) => {
      const { runTemplatesDevCommand } = await import("./templates-cli.project.js");
      await runTemplatesDevCommand(path, opts);
    });

  templates
    .command("build")
    .description("Build a reproducible Template package artifact")
    .argument("[path]", "Project directory", ".")
    .requiredOption("--out <artifact>", "New .tgz artifact to create")
    .option("--json", "Print JSON", false)
    .action(async (path: string, opts: TemplatesBuildOptions) => {
      const { runTemplatesBuildCommand } = await import("./templates-cli.project.js");
      await runTemplatesBuildCommand(path, opts);
    });

  templates
    .command("inspect")
    .description("Validate a Template package or local development manifest")
    .argument("<source>", "Path to a Template package directory or grouped manifest")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: TemplatesInspectOptions) => {
      const { runTemplatesInspectCommand } = await import("./templates-cli.runtime.js");
      await runTemplatesInspectCommand(source, opts);
    });

  templates
    .command("add")
    .description("Add a new agent and its requirements from a Template")
    .argument("<source>", "Path to a Template package directory or grouped manifest")
    .option("--dry-run", "Preview all actions without mutating state", false)
    .option("--accept-capabilities", "Accept required plugin capabilities", false)
    .option("--acknowledge-clawhub-risk", "Acknowledge ClawHub trust warnings", false)
    .option("--agent-id <id>", "Override the requested id with an unused local agent id")
    .option("--workspace <path>", "Override the derived new workspace path")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: TemplatesAddOptions) => {
      const { runTemplatesAddCommand } = await import("./templates-cli.runtime.js");
      await runTemplatesAddCommand(source, opts);
    });

  applyParentDefaultHelpAction(templates);
}
