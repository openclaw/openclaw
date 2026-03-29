import { Command } from "commander";
import { getPluginCliCommandDescriptors } from "../../plugins/cli.js";
import { VERSION } from "../../version.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { configureProgramHelp } from "./help.js";
import { getSubCliEntries } from "./subcli-descriptors.js";

function buildRootHelpProgram(): Command {
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
  for (const command of getPluginCliCommandDescriptors()) {
    if (existingCommands.has(command.name)) {
      continue;
    }
    program.command(command.name).description(command.description);
    existingCommands.add(command.name);
  }

  return program;
}

export function renderRootHelpText(): string {
  const program = buildRootHelpProgram();
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

export function outputRootHelp(): void {
  process.stdout.write(renderRootHelpText());
}
