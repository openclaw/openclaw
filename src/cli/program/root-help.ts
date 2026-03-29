import { Command } from "commander";
import { getPluginCliCommandDescriptors } from "../../plugins/cli.js";
import { VERSION } from "../../version.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { configureProgramHelp } from "./help.js";
import { getSubCliEntries } from "./subcli-descriptors.js";

async function buildRootHelpProgram(): Promise<Command> {
  const program = new Command();
  configureProgramHelp(program, {
    programVersion: VERSION,
    channelOptions: [],
    messageChannelOptions: "",
    agentChannelOptions: "",
  });

  const existingCommands = new Set<string>();
  for (const command of getCoreCliCommandDescriptors()) {
    program.command(command.name).description(command.description);
    existingCommands.add(command.name);
  }
  for (const command of getSubCliEntries()) {
    if (existingCommands.has(command.name)) {
      continue;
    }
    program.command(command.name).description(command.description);
    existingCommands.add(command.name);
  }
  for (const command of await getPluginCliCommandDescriptors()) {
    if (existingCommands.has(command.name)) {
      continue;
    }
    program.command(command.name).description(command.description);
    existingCommands.add(command.name);
  }

  return program;
}

export async function renderRootHelpText(): Promise<string> {
  const program = await buildRootHelpProgram();
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captureWrite: typeof process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = captureWrite;
  try {
    program.outputHelp();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

export async function outputRootHelp(): Promise<void> {
  process.stdout.write(await renderRootHelpText());
}
