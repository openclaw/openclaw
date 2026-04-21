import type { Command } from "commander";
import { dashboardCommand } from "../../commands/dashboard.js";
import { diagnoseCommand } from "../../commands/diagnose.js";
import { doctorCommand } from "../../commands/doctor.js";
import { resetCommand } from "../../commands/reset.js";
import { uninstallCommand } from "../../commands/uninstall.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerMaintenanceCommands(program: Command) {
  program
    .command("diagnose")
    .description("AI-powered diagnostic analysis of gateway logs and configuration")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("What this does:")}
  Assembles diagnostic context (gateway log, redacted config, health data,
  version info, auth events, system memory) and sends it to an AI model for
  structured analysis. The report identifies issues, root causes, and fixes.

${theme.heading("Examples:")}
  ${theme.command("openclaw diagnose")}              ${theme.muted("# stream Markdown report to stdout")}
  ${theme.command("openclaw diagnose --canvas")}      ${theme.muted("# also save HTML to canvas for browser viewing")}
  ${theme.command("openclaw diagnose --output r.md")} ${theme.muted("# save report to file")}
  ${theme.command("openclaw diagnose --json")}        ${theme.muted("# structured JSON output")}
  ${theme.command("openclaw diagnose --model claude-haiku-4-5")} ${theme.muted("# override model")}

${theme.muted("Docs:")} ${formatDocsLink("/cli/diagnose", "docs.openclaw.ai/cli/diagnose")}\n`,
    )
    .option("--output <path>", "Save the Markdown report to a file")
    .option("--canvas", "Save an HTML report to ~/.openclaw/canvas/ for browser viewing", false)
    .option("--json", "Output result as JSON", false)
    .option("--model <id>", "Override the model used for analysis")
    .option(
      "--max-log-entries <n>",
      "Maximum WARN/ERROR/FATAL log entries to include (default: 200)",
      "200",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await diagnoseCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          canvas: Boolean(opts.canvas),
          json: Boolean(opts.json),
          model: opts.model as string | undefined,
          maxLogEntries: Number.parseInt(opts.maxLogEntries as string, 10) || 200,
        });
        defaultRuntime.exit(0);
      });
    });

  program
    .command("doctor")
    .description("Health checks + quick fixes for the gateway and channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/doctor", "docs.openclaw.ai/cli/doctor")}\n`,
    )
    .option("--no-workspace-suggestions", "Disable workspace memory system suggestions", false)
    .option("--yes", "Accept defaults without prompting", false)
    .option("--repair", "Apply recommended repairs without prompting", false)
    .option("--fix", "Apply recommended repairs (alias for --repair)", false)
    .option("--force", "Apply aggressive repairs (overwrites custom service config)", false)
    .option("--non-interactive", "Run without prompts (safe migrations only)", false)
    .option("--generate-gateway-token", "Generate and configure a gateway token", false)
    .option("--deep", "Scan system services for extra gateway installs", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await doctorCommand(defaultRuntime, {
          workspaceSuggestions: opts.workspaceSuggestions,
          yes: Boolean(opts.yes),
          repair: Boolean(opts.repair) || Boolean(opts.fix),
          force: Boolean(opts.force),
          nonInteractive: Boolean(opts.nonInteractive),
          generateGatewayToken: Boolean(opts.generateGatewayToken),
          deep: Boolean(opts.deep),
        });
        defaultRuntime.exit(0);
      });
    });

  program
    .command("dashboard")
    .description("Open the Control UI with your current token")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dashboard", "docs.openclaw.ai/cli/dashboard")}\n`,
    )
    .option("--no-open", "Print URL but do not launch a browser")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await dashboardCommand(defaultRuntime, {
          noOpen: opts.open === false,
        });
      });
    });

  program
    .command("reset")
    .description("Reset local config/state (keeps the CLI installed)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/reset", "docs.openclaw.ai/cli/reset")}\n`,
    )
    .option("--scope <scope>", "config|config+creds+sessions|full (default: interactive prompt)")
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --scope + --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await resetCommand(defaultRuntime, {
          scope: opts.scope,
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });

  program
    .command("uninstall")
    .description("Uninstall the gateway service + local data (CLI remains)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/uninstall", "docs.openclaw.ai/cli/uninstall")}\n`,
    )
    .option("--service", "Remove the gateway service", false)
    .option("--state", "Remove state + config", false)
    .option("--workspace", "Remove workspace dirs", false)
    .option("--app", "Remove the macOS app", false)
    .option("--all", "Remove service + state + workspace + app", false)
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await uninstallCommand(defaultRuntime, {
          service: Boolean(opts.service),
          state: Boolean(opts.state),
          workspace: Boolean(opts.workspace),
          app: Boolean(opts.app),
          all: Boolean(opts.all),
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });
}
