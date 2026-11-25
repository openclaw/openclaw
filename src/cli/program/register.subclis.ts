import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { shouldEagerRegisterSubcommands } from "../command-registration-policy.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { removeCommandByName } from "./command-tree.js";
import {
  findCommandGroupEntry,
  registerCommandGroupByName,
  registerCommandGroups,
  type CommandGroupEntry,
} from "./register-command-groups.js";
import { getSubCliEntriesCore, type SubCliRegistrationContext } from "./subcli-descriptors.js";
export type { SubCliRegistrationContext } from "./subcli-descriptors.js";

function shouldRegisterGatewayRunOnly(name: string, argv: string[]): boolean {
  if (name !== "gateway") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion || invocation.commandPath[0] !== "gateway") {
    return false;
  }
  return invocation.commandPath.length === 1 || invocation.commandPath[1] === "run";
}

function resolveSubCliCommandGroups(
  argv: string[],
  context: SubCliRegistrationContext = {},
): CommandGroupEntry[] {
  const descriptors = getSubCliEntriesCore();
  const groups = new Map<
    (typeof descriptors)[number]["register"],
    { placeholders: NamedCommandDescriptor[]; register: (program: Command) => Promise<void> | void }
  >();
  for (const descriptor of descriptors) {
    const group = groups.get(descriptor.register);
    if (group) {
      group.placeholders.push(descriptor);
    } else {
      groups.set(descriptor.register, {
        placeholders: [descriptor],
        register: (program: Command) => descriptor.register(program, argv, context),
      });
    }
  }
  return [...groups.values()];
}

export function getSubCliCompletionGroups(argv: string[] = process.argv) {
  const entries = resolveSubCliCommandGroups(argv, { purpose: "completion" });
  const groups: Array<{ name: string; entry: CommandGroupEntry }> = [];
  let previous: CommandGroupEntry | undefined;
  // Keep descriptor names for warnings and separated group visits for final command order.
  for (const { name } of getSubCliEntriesCore()) {
    const entry = name === "completion" ? undefined : findCommandGroupEntry(entries, name);
    if (entry && entry !== previous) {
      groups.push({ name, entry });
    }
    previous = entry;
  }
  return groups;
}

export async function registerSubCliByName(
  program: Command,
  name: string,
  argv: string[] = process.argv,
  context: SubCliRegistrationContext = {},
): Promise<boolean> {
  if (shouldRegisterGatewayRunOnly(name, argv)) {
    // Hot path for `gateway run`: avoid loading the full gateway command tree.
    const { addGatewayRunCommand } = await import("../gateway-cli/run-command.js");
    removeCommandByName(program, "gateway");
    const gateway = addGatewayRunCommand(
      program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
    );
    addGatewayRunCommand(
      gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
    );
    return true;
  }
  return registerCommandGroupByName(program, resolveSubCliCommandGroups(argv, context), name);
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  const { primary } = resolveCliArgvInvocation(argv);
  const entries = resolveSubCliCommandGroups(argv);
  const completion = findCommandGroupEntry(entries, "completion");
  const options = {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: true,
  };
  registerCommandGroups(
    program,
    entries.filter((entry) => entry !== completion),
    options,
  );
  // Completion remains available beside a narrowed primary command, and registers last.
  if (completion) {
    registerCommandGroups(program, [completion], options);
  }
}
