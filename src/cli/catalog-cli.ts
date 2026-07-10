import type { Command } from "commander";
import { buildCatalogList, renderCatalogListMarkdown } from "../cli-catalog-overlay/list.js";
import { buildPluginCatalogCommands } from "../cli-catalog-overlay/plugin-commands.js";
import { collectRuntimeCommandTree } from "../cli-catalog-overlay/runtime-commands.js";
import { loadPluginCliDescriptorEntries } from "../plugins/cli-registry-loader.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

async function loadPluginCommands() {
  const entries = await withConsoleLogsRoutedToStderrForJson(
    ["--json"],
    async () => await loadPluginCliDescriptorEntries({}),
  );
  return buildPluginCatalogCommands(entries);
}

function validateOutputOptions(
  opts: { json?: boolean; markdown?: boolean },
  command: Command,
): void {
  if (opts.json && opts.markdown) {
    command.error("error: --json and --markdown cannot be combined");
  }
}

export function registerCommandsCli(program: Command): void {
  const commands = program.command("commands").description("List OpenClaw commands");

  commands
    .command("list")
    .description("List CLI, routed, runtime, and opt-in plugin commands")
    .option("--json", "Output JSON", false)
    .option("--markdown", "Output Markdown", false)
    .option("--plugin-descriptors", "Include plugin CLI descriptor metadata", false)
    .action(
      async (
        opts: { json?: boolean; markdown?: boolean; pluginDescriptors?: boolean },
        command: Command,
      ) => {
        validateOutputOptions(opts, command);
        const runtimeCommands = collectRuntimeCommandTree(program);
        const pluginCommands = opts.pluginDescriptors ? await loadPluginCommands() : [];
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(buildCatalogList({ runtimeCommands, pluginCommands }), null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(`${renderCatalogListMarkdown({ runtimeCommands, pluginCommands })}\n`);
      },
    );

  applyParentDefaultHelpAction(commands);
}
