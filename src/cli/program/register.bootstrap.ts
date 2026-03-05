import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { bootstrapCommand } from "../bootstrap.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerBootstrapCommand(program: Command) {
  program
    .command("bootstrap")
    .description("Bootstrap DenchClaw on top of OpenClaw and open the web UI")
    .option("--profile <name>", "Compatibility flag; non-dench values are ignored with a warning")
    .option("--force-onboard", "Run onboarding even if config already exists", false)
    .option("--non-interactive", "Skip prompts where possible", false)
    .option("--yes", "Auto-approve install prompts", false)
    .option("--skip-update", "Skip update prompt/check", false)
    .option("--update-now", "Run OpenClaw update before onboarding", false)
    .option("--gateway-port <port>", "Gateway port override for first-run onboarding")
    .option("--web-port <port>", "Preferred web UI port (default: 3100)")
    .option("--no-open", "Do not open the browser automatically")
    .option("--json", "Output summary as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/onboard", "docs.openclaw.ai/cli/onboard")}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await bootstrapCommand({
          profile: opts.profile as string | undefined,
          forceOnboard: Boolean(opts.forceOnboard),
          nonInteractive: Boolean(opts.nonInteractive),
          yes: Boolean(opts.yes),
          skipUpdate: Boolean(opts.skipUpdate),
          updateNow: Boolean(opts.updateNow),
          gatewayPort: opts.gatewayPort as string | undefined,
          webPort: opts.webPort as string | undefined,
          noOpen: Boolean(opts.open === false),
          json: Boolean(opts.json),
        });
      });
    });
}
