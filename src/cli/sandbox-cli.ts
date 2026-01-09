import type { Command } from "commander";

import {
  sandboxListCommand,
  sandboxRecreateCommand,
} from "../commands/sandbox.js";
import { defaultRuntime } from "../runtime.js";

export function registerSandboxCli(program: Command) {
  const sandbox = program
    .command("sandbox")
    .description("Manage sandbox containers (Docker-based agent isolation)");

  sandbox
    .command("list")
    .description("List sandbox containers and their status")
    .option("--browser", "List browser containers only", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await sandboxListCommand(
          {
            browser: Boolean(opts.browser),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  sandbox
    .command("recreate")
    .description("Recreate sandbox containers (e.g., after image updates)")
    .option("--all", "Recreate all sandbox containers", false)
    .option("--session <key>", "Recreate container for specific session")
    .option("--agent <id>", "Recreate containers for specific agent")
    .option("--browser", "Only recreate browser containers", false)
    .option("--force", "Skip confirmation prompt", false)
    .addHelpText(
      "after",
      `
Examples:
  clawd sandbox recreate --all          # Recreate all sandbox containers
  clawd sandbox recreate --session main # Recreate container for main session
  clawd sandbox recreate --agent mybot  # Recreate containers for 'mybot' agent
  clawd sandbox recreate --browser      # Only recreate browser containers
  clawd sandbox recreate --all --force  # Skip confirmation

Use this command after updating sandbox images or changing sandbox configuration
to ensure containers use the latest settings.`,
    )
    .action(async (opts) => {
      try {
        await sandboxRecreateCommand(
          {
            all: Boolean(opts.all),
            session: opts.session as string | undefined,
            agent: opts.agent as string | undefined,
            browser: Boolean(opts.browser),
            force: Boolean(opts.force),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action shows list
  sandbox.action(async () => {
    try {
      await sandboxListCommand({ browser: false, json: false }, defaultRuntime);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
}
