// Commander registration for `openclaw init --mode teammate`.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

const INIT_EXAMPLES = [
  ["openclaw init --mode teammate", "Create a persistent worker computer (Docker default)."],
  [
    "openclaw init --mode teammate --backend firecracker",
    "Same volume/secret story with a Firecracker/Kata OCI runtime.",
  ],
  ["openclaw init --mode teammate --json", "Machine-readable install summary."],
] as const;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Install profiles; teammate mode pins exec onto a persistent worker")
    .option("--mode <mode>", "Install mode: teammate")
    .option(
      "--backend <backend>",
      "Teammate worker backend: docker|openshell|firecracker (default: docker)",
    )
    .option("--workspace <dir>", "Workspace directory for the first agent")
    .option("--json", "Output the install summary as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(INIT_EXAMPLES)}\n\n` +
        `${theme.muted("Docs:")} ${formatDocsLink("/cli/init", "docs.openclaw.ai/cli/init")}\n`,
    )
    .action(async (rawOptions) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { initCommand } = await import("../../commands/init.js");
        await initCommand(
          {
            mode: readStringValue(rawOptions.mode),
            backend: readStringValue(rawOptions.backend),
            workspace: readStringValue(rawOptions.workspace),
            json: Boolean(rawOptions.json),
          },
          defaultRuntime,
        );
      });
    });
}
