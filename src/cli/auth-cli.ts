import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { resolveOptionFromCommand, runCommandWithRuntime } from "./cli-utils.js";

function runAuthCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function registerAuthCli(program: Command) {
  const auth = program.command("auth").description("Manage model auth profiles");
  auth.option("--agent <id>", "Agent id to inspect");
  auth.action(() => {
    auth.help();
  });

  auth
    .command("list")
    .description("List configured model auth profiles")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output JSON", false)
    .option("--plain", "Print profile ids only", false)
    .action(async (opts, command) => {
      const agent =
        (opts.agent as string | undefined) ??
        resolveOptionFromCommand<string>(command, "agent") ??
        resolveOptionFromCommand<string>(auth, "agent");
      await runAuthCommand(async () => {
        const { modelsAuthListCommand } = await import("../commands/models/auth-list.js");
        await modelsAuthListCommand(
          {
            json: Boolean(opts.json),
            plain: Boolean(opts.plain),
            agent,
          },
          defaultRuntime,
        );
      });
    });
}
