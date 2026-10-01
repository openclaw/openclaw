import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

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
    .description("List storage locations and probe their availability")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }, command: Command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { storageListCommand } = await import("../../commands/storage.js");
        await storageListCommand(defaultRuntime, {
          json: (inheritOptionFromParent<boolean>(command, "json") ?? opts.json) === true,
        });
      });
    });

  storage
    .command("init <name>")
    .description("Initialize a new location or verify its existing marker and encryption key")
    .option("--json", "Output JSON", false)
    .action(async (name: string, opts: { json?: boolean }, command: Command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { storageInitCommand } = await import("../../commands/storage.js");
        await storageInitCommand(defaultRuntime, name, {
          json: (inheritOptionFromParent<boolean>(command, "json") ?? opts.json) === true,
        });
      });
    });

  storage
    .command("test <name>")
    .description("Write, read, verify, and delete a temporary probe object")
    .option("--json", "Output JSON", false)
    .action(async (name: string, opts: { json?: boolean }, command: Command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { storageTestCommand } = await import("../../commands/storage.js");
        await storageTestCommand(defaultRuntime, name, {
          json: (inheritOptionFromParent<boolean>(command, "json") ?? opts.json) === true,
        });
      });
    });
}
