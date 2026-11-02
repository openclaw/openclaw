import { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginCliCommandDescriptors } from "../../plugins/cli-root-descriptors.js";
import type { PluginLoadOptions } from "../../plugins/loader.js";
import { VERSION } from "../../version.js";
import {
  addCommandDescriptorsToProgram,
  collectUniqueCommandDescriptors,
} from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { configureProgramHelp, formatProgramHelpOutput } from "./help.js";
import { getSubCliCommandMetadata } from "./subcli-command-metadata.js";

/** Options for rendering root help without fully registering the live CLI. */
export type RootHelpRenderOptions = Pick<PluginLoadOptions, "pluginSdkResolution"> & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

/** Write root help without registering command runtimes. */
export async function outputRootHelp(renderOptions?: RootHelpRenderOptions): Promise<void> {
  const program = new Command();
  const pluginDescriptors = renderOptions?.config
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
    collectUniqueCommandDescriptors<NamedCommandDescriptor>([
      getCoreCliCommandDescriptors(),
      getSubCliCommandMetadata(),
      pluginDescriptors,
    ]),
  );

  let output = "";
  program.configureOutput({ writeOut: (chunk) => (output += formatProgramHelpOutput(chunk)) });
  program.outputHelp();
  process.stdout.write(output);
}
