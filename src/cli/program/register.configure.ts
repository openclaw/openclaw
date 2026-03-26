import type { Command } from "commander";
import { configureSurfaceCommand } from "../../commands/configure-surface.js";
import {
  CONFIGURE_WIZARD_SECTIONS,
  configureCommandFromSectionsArg,
} from "../../commands/configure.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

function extractSurfaceSectionsFromRawArgs(rawArgs: string[]): string[] {
  const configureIndex = rawArgs.indexOf("configure");
  if (configureIndex === -1) {
    return [];
  }

  let surfaceIndex = -1;
  for (let index = configureIndex + 1; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--section") {
      index += 1;
      continue;
    }
    if (token.startsWith("--section=")) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    surfaceIndex = token === "surface" ? index : -1;
    break;
  }

  if (surfaceIndex === -1) {
    return [];
  }

  const sections: string[] = [];
  for (let index = surfaceIndex + 1; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--section") {
      const value = rawArgs[index + 1];
      if (value && !value.startsWith("-")) {
        sections.push(value);
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--section=")) {
      const value = token.slice("--section=".length).trim();
      if (value) {
        sections.push(value);
      }
    }
  }
  return sections;
}

export function registerConfigureCommand(program: Command) {
  const programWithRawArgs = program as Command & { rawArgs?: string[] };
  const configure = program
    .command("configure")
    .description("Interactive configuration for credentials, channels, gateway, and agent defaults")
    .enablePositionalOptions()
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/configure", "docs.openclaw.ai/cli/configure")}\n`,
    )
    .option(
      "--section <section>",
      `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await configureCommandFromSectionsArg(opts.section, defaultRuntime);
      });
    });

  configure
    .command("surface")
    .description("Export provider/channel setup surfaces for external configuration UIs")
    .requiredOption("--json-out <file>", "Write JSON output to this file")
    .option(
      "--section <section>",
      "Setup sections to export (repeatable): providers, channels",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--installed-only", "Only export installed setup surfaces", false)
    .action(async (opts) => {
      const section = extractSurfaceSectionsFromRawArgs(programWithRawArgs.rawArgs ?? []);
      await runCommandWithRuntime(defaultRuntime, async () => {
        await configureSurfaceCommand({
          jsonOut: opts.jsonOut,
          section,
          installedOnly: opts.installedOnly,
          runtime: defaultRuntime,
        });
      });
    });
}
