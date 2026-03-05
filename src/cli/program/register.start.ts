import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { startWebRuntimeCommand } from "../web-runtime-command.js";

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start Dench managed web runtime without updating assets")
    .option("--profile <name>", "Compatibility flag; non-dench values are ignored with a warning")
    .option("--web-port <port>", "Web runtime port override")
    .option("--no-open", "Do not open the browser automatically")
    .option("--json", "Output summary as JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await startWebRuntimeCommand({
          profile: opts.profile as string | undefined,
          webPort: opts.webPort as string | undefined,
          noOpen: Boolean(opts.open === false),
          json: Boolean(opts.json),
        });
      });
    });
}
