import type { Command } from "commander";
import { setupWizardCommand } from "../../commands/onboard.js";
import { setupCommand } from "../../commands/setup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";

export function registerSetupCommand(program: Command) {
  program
    .command("setup")
    .description("Set up a local Gemma backend (auto-detects hardware, provisions, and verifies)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)",
    )
    .option(
      "--advanced",
      "Run interactive advanced setup with manual backend/model/port selection",
      false,
    )
    .option("--workspace-only", "Only initialize workspace config (skip Gemma provisioning)", false)
    .option("--wizard", "Run interactive onboarding (workspace config)", false)
    .option("--non-interactive", "Run onboarding without prompts", false)
    .option("--mode <mode>", "Onboard mode: local|remote")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // gemmaclaw: route to Gemma setup wizard by default.
        // Use --workspace-only or --wizard to get the original OpenClaw setup behavior.
        const hasWorkspaceOnlyFlags = hasExplicitOptions(command, [
          "wizard",
          "nonInteractive",
          "mode",
          "remoteUrl",
          "remoteToken",
        ]);
        if (opts.workspaceOnly || opts.wizard || hasWorkspaceOnlyFlags) {
          if (opts.wizard || hasWorkspaceOnlyFlags) {
            await setupWizardCommand(
              {
                workspace: opts.workspace as string | undefined,
                nonInteractive: Boolean(opts.nonInteractive),
                mode: opts.mode as "local" | "remote" | undefined,
                remoteUrl: opts.remoteUrl as string | undefined,
                remoteToken: opts.remoteToken as string | undefined,
              },
              defaultRuntime,
            );
          } else {
            await setupCommand({ workspace: opts.workspace as string | undefined }, defaultRuntime);
          }
          return;
        }

        // Default: Gemma setup wizard.
        const { setupGemmaCommand } = await import("../../commands/setup-gemma.js");
        await setupGemmaCommand({ advanced: Boolean(opts.advanced) }, defaultRuntime);
      });
    });
}
