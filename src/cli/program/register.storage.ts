import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { formatCliOperatorError } from "../failure-output.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

function reportStorageError(error: unknown): void {
  defaultRuntime.error(sanitizeTerminalText(formatCliOperatorError(error)));
  defaultRuntime.exit(1);
}

export function registerStorageCommand(program: Command): void {
  const storage = program
    .command("storage")
    .description("List, initialize, and test configured storage locations")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      `\nDocs: ${formatDocsLink("/cli/storage", "docs.openclaw.ai/cli/storage")}\n`,
    );
  applyParentDefaultHelpAction(storage);

  storage
    .command("list")
    .description("List storage locations and check their availability")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }, command: Command) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { storageListCommand } = await import("../../commands/storage.js");
          await storageListCommand(defaultRuntime, {
            json: (inheritOptionFromParent<boolean>(command, "json") ?? opts.json) === true,
          });
        },
        reportStorageError,
      );
    });

  for (const [operation, description, handler] of [
    [
      "init",
      "Initialize a new location or verify its existing marker and encryption key",
      "storageInitCommand",
    ],
    ["test", "Write, read, verify, and delete a temporary check object", "storageTestCommand"],
  ] as const) {
    storage
      .command(`${operation} <name>`)
      .description(description)
      .option("--json", "Output JSON", false)
      .action((name: string, opts: { json?: boolean }, command: Command) =>
        runCommandWithRuntime(
          defaultRuntime,
          async () => {
            const commands = await import("../../commands/storage.js");
            await commands[handler](defaultRuntime, name, {
              json: (inheritOptionFromParent<boolean>(command, "json") ?? opts.json) === true,
            });
          },
          reportStorageError,
        ),
      );
  }
}
