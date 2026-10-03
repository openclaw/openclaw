import { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginCliCommandDescriptors } from "../../plugins/cli-root-descriptors.js";
import type { PluginLoadOptions } from "../../plugins/loader.js";
import { VERSION } from "../../version.js";
import {
  addCommandDescriptorsToProgram,
  collectUniqueCommandDescriptors,
} from "./command-descriptor-utils.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { configureProgramHelp, formatProgramHelpOutput } from "./help.js";
import { getSubCliEntriesCore } from "./subcli-descriptors.js";

/** Options for rendering root help without fully registering the live CLI. */
export type RootHelpRenderOptions = Pick<PluginLoadOptions, "pluginSdkResolution"> & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includePluginDescriptors?: boolean;
};

/** Render root help text without registering command runtimes. */
export async function renderRootHelpText(renderOptions?: RootHelpRenderOptions): Promise<string> {
  const program = new Command();
  const pluginDescriptors =
    renderOptions?.includePluginDescriptors === true || renderOptions?.config
      ? await getPluginCliCommandDescriptors(renderOptions.config, renderOptions.env, {
          pluginSdkResolution: renderOptions.pluginSdkResolution,
        })
      : [];
  configureProgramHelp(
    program,
    { programVersion: VERSION },
    {
      commandsWithSubcommands: new Set(
        pluginDescriptors
          .filter((descriptor) => descriptor.hasSubcommands)
          .map((descriptor) => descriptor.name),
      ),
    },
  );

  addCommandDescriptorsToProgram(
    program,
    collectUniqueCommandDescriptors([
      getCoreCliCommandDescriptors(),
      getSubCliEntriesCore(),
      pluginDescriptors,
    ]),
  );

  let output = "";
  program.configureOutput({ writeOut: (chunk) => (output += formatProgramHelpOutput(chunk)) });
  program.outputHelp();
  return output;
}

/** Write rendered root help directly to stdout. */
export async function outputRootHelp(renderOptions?: RootHelpRenderOptions): Promise<void> {
  process.stdout.write(await renderRootHelpText(renderOptions));
}
