import type { Command } from "commander";
import { getCommandPositionalsWithRootOptions } from "../../infra/cli-root-options.js";
import {
  getMachineOutputCommandPath,
  MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION,
} from "../machine-output-argv.js";

export const CRON_GATEWAY_OPTION_NAMES = [
  "url",
  "port",
  "token",
  "password",
  "timeout",
  "expectFinal",
] as const;

const CRON_GATEWAY_VALUE_FLAGS = CRON_GATEWAY_OPTION_NAMES.filter(
  (name) => name !== "expectFinal",
).map((name) => `--${name}`);

const CRON_SCRATCH_JSON_OPTION_DESCRIPTION =
  "Output scratch plus revision metadata as JSON; writes return JSON by default";

const CRON_OUTPUT_COMMANDS = {
  status: [],
  add: ["create"],
  rm: ["remove", "delete"],
  enable: [],
  disable: [],
  get: [],
  runs: [],
  history: [],
  run: [],
  edit: [],
  scratch: [],
} as const;

type CronOutputCommandName = keyof typeof CRON_OUTPUT_COMMANDS;
const MACHINE_OUTPUT_COMMANDS = new Set<string>(
  Object.entries(CRON_OUTPUT_COMMANDS).flatMap(([name, aliases]) => [name].concat(aliases)),
);

export function createCronOutputCommand(parent: Command, name: CronOutputCommandName): Command {
  const command = parent.command(name);
  for (const alias of CRON_OUTPUT_COMMANDS[name]) {
    command.alias(alias);
  }
  return command.option(
    "--json",
    name === "scratch"
      ? CRON_SCRATCH_JSON_OPTION_DESCRIPTION
      : MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION,
  );
}

export function isCronMachineOutput(argv: readonly string[]): boolean {
  const [root] = getMachineOutputCommandPath(argv, 1);
  if (!root) {
    return false;
  }
  const [command] =
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: [root],
      booleanFlags: ["--expect-final"],
      valueFlags: CRON_GATEWAY_VALUE_FLAGS,
      maxPositionals: 1,
    }) ?? [];
  return command !== undefined && MACHINE_OUTPUT_COMMANDS.has(command);
}
