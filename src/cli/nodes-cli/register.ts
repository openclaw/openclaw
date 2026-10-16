import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { hasFlag } from "../argv.js";
import { formatHelpExamples } from "../help-format.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { setCommandJsonMode } from "../program/json-mode.js";
import { isNodesMachineOutput } from "./output-mode.js";
import { registerNodesCameraCommands } from "./register.camera.js";
import { registerNodesInvokeCommands } from "./register.invoke.js";
import { registerNodesLocationCommands } from "./register.location.js";
import { registerNodesNotifyCommand } from "./register.notify.js";
import { registerNodesPairingCommands } from "./register.pairing.js";
import { registerNodesPushCommand } from "./register.push.js";
import { registerNodesScreenCommands } from "./register.screen.js";
import { registerNodesStatusCommands } from "./register.status.js";

/** Register the `nodes` command group and lazy plugin-provided node commands. */
export async function registerNodesCli(program: Command, argv: readonly string[] = process.argv) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned nodes (pairing, status, invoke, and media)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw nodes status", "List known nodes with live status."],
          ["openclaw nodes pending", "Show pending node pairing requests."],
          ["openclaw nodes remove --node <id|name|ip>", "Remove a stale paired node entry."],
          [
            'openclaw nodes invoke --node <id> --command system.which --params \'{"bins":["uname"]}\'',
            "Invoke a node command directly.",
          ],
          ["openclaw nodes camera snap --node <id>", "Capture a photo from a node camera."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/nodes", "docs.openclaw.ai/cli/nodes")}\n`,
    );

  registerNodesStatusCommands(nodes);
  registerNodesPairingCommands(nodes);
  registerNodesInvokeCommands(nodes);
  registerNodesNotifyCommand(nodes);
  registerNodesPushCommand(nodes);
  registerNodesCameraCommands(nodes);
  registerNodesScreenCommands(nodes);
  registerNodesLocationCommands(nodes);
  setCommandJsonMode(nodes, "output", ({ argv: commandArgv }) => isNodesMachineOutput(commandArgv));

  // Built-ins and completion must not load the plugin runtime. Bare/root help
  // still needs plugin-provided subcommands.
  const { commandPath } = resolveCliArgvInvocation([...argv]);
  if (
    commandPath[0] === "completion" ||
    (commandPath[0] === "nodes" &&
      nodes.commands.some((command) => command.name() === commandPath[1]))
  ) {
    return;
  }
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
  const parentHelp =
    commandPath.length === 1 &&
    commandPath[0] === "nodes" &&
    (hasFlag([...argv], "--help") || hasFlag([...argv], "-h"));
  await withConsoleLogsRoutedToStderrForJson(
    argv,
    async () =>
      await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
        mode: parentHelp ? "metadata" : "lazy",
        primary: "nodes",
      }),
  );
}
