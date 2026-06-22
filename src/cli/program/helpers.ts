// Shared Commander registration helpers for repeated options, positive ints, and lazy reparse args.
import { InvalidArgumentError, type Command } from "commander";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";

/** Commander option collector for repeatable string flags. */
export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse an optional positive integer, treating empty values as unset. */
export function parsePositiveIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseStrictPositiveInteger(value);
}

/** Parse a positive integer without treating empty values specially. */
export function parseStrictPositiveIntOrUndefined(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

/** Commander argument parser for required positive integer options. */
export function parseStrictPositiveIntOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

/** Return positional args captured by a Commander action command. */
export function resolveActionArgs(actionCommand?: Command): string[] {
  if (!actionCommand) {
    return [];
  }
  const args = (actionCommand as Command & { args?: string[] }).args;
  return Array.isArray(args) ? args : [];
}

function isDefaultOptionValue(command: Command, name: string): boolean {
  if (typeof command.getOptionValueSource !== "function") {
    return false;
  }
  return command.getOptionValueSource(name) === "default";
}

function appendOptionValue(out: string[], flag: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (value === false) {
    if (flag.startsWith("--no-")) {
      out.push(flag);
    }
    return;
  }
  if (value === true) {
    out.push(flag);
    return;
  }
  const arg = stringifyOptionValue(value);
  if (arg !== undefined) {
    out.push(flag, arg);
  }
}

function stringifyOptionValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

/** Reconstruct explicit option tokens from a Commander command for lazy reparsing. */
export function resolveCommandOptionArgs(command?: Command): string[] {
  if (!command) {
    return [];
  }
  const out: string[] = [];
  for (const option of command.options) {
    const name = option.attributeName();
    if (isDefaultOptionValue(command, name)) {
      continue;
    }
    const flag = option.long ?? option.short;
    if (!flag) {
      continue;
    }
    const value = command.getOptionValue(name);
    if (Array.isArray(value)) {
      for (const item of value) {
        appendOptionValue(out, flag, item);
      }
      continue;
    }
    appendOptionValue(out, flag, value);
  }
  return out;
}

function isValueOption(option: Command["options"][number]): boolean {
  // Commander marks options that take an argument with `required` (`<value>`)
  // or `optional` (`[value]`); a bare flag has neither.
  return option.required || option.optional;
}

function collectOptionFlags(
  commands: readonly Command[],
  exclude?: Command,
): { booleanFlags: Set<string>; valueFlags: Set<string> } {
  const booleanFlags = new Set<string>();
  const valueFlags = new Set<string>();
  const excludeFlags = new Set<string>();
  if (exclude) {
    for (const option of exclude.options) {
      for (const flag of [option.long, option.short]) {
        if (flag) {
          excludeFlags.add(flag);
        }
      }
    }
  }
  for (const command of commands) {
    for (const option of command.options) {
      for (const flag of [option.long, option.short]) {
        if (!flag || excludeFlags.has(flag)) {
          continue;
        }
        if (isValueOption(option)) {
          valueFlags.add(flag);
        } else {
          booleanFlags.add(flag);
        }
      }
    }
  }
  return { booleanFlags, valueFlags };
}

function isHoistableValueToken(arg: string | undefined): boolean {
  return Boolean(arg && arg !== "--" && (!arg.startsWith("-") || /^-\d+(?:\.\d+)?$/.test(arg)));
}

function consumeHoistableOption(
  args: readonly string[],
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!valueFlags.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return isHoistableValueToken(args[index + 1]) ? 2 : 1;
}

/**
 * Hoists options owned by a lazy subcommand's parent (and ancestor) commands from
 * after the subcommand to before it. Commander rejects a parent option placed
 * after a subcommand (`browser tabs --browser-profile remote`), but the lazy
 * reparse reuses the original argv verbatim, so a parent option captured after
 * the subcommand never reaches the parent. Moving it before the subcommand
 * restores the pre-lazy behavior where parent options could follow the
 * subcommand. Options owned by the subcommand itself are left in place.
 */
export function hoistParentOptionsBeforeSubcommand(params: {
  argv: string[];
  parentCommand: Command;
  subcommandName: string;
  subcommandCommand?: Command;
}): string[] {
  const { argv, parentCommand, subcommandName, subcommandCommand } = params;

  // Ancestor commands own options that may need hoisting: the parent plus its
  // ancestor subcommands, excluding the root program (whose global options are
  // normalized before this command and live before the parent name).
  const ancestors: Command[] = [];
  for (
    let current: Command | null | undefined = parentCommand;
    current && current.parent;
    current = current.parent
  ) {
    ancestors.push(current);
  }
  if (ancestors.length === 0) {
    return argv;
  }

  let root: Command | null | undefined = parentCommand;
  while (root && root.parent) {
    root = root.parent;
  }
  const rootFlags = collectOptionFlags(root && root !== parentCommand ? [root] : []);
  const ancestorFlags = collectOptionFlags(ancestors, subcommandCommand);

  // Locate the parent command name token, skipping the node/<program> prefix and
  // any root options, then locate the subcommand name token, skipping ancestor
  // options already placed before it.
  const parentName = parentCommand.name();
  let i = 0;
  for (; i < argv.length; i += 1) {
    if (argv[i] === parentName) {
      break;
    }
    const consumed = consumeHoistableOption(argv, i, rootFlags.booleanFlags, rootFlags.valueFlags);
    if (consumed > 0) {
      i += consumed - 1;
    }
  }
  if (i >= argv.length || argv[i] !== parentName) {
    return argv;
  }
  i += 1;

  let subcommandIndex = -1;
  for (; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--") {
      break;
    }
    const consumed = consumeHoistableOption(
      argv,
      i,
      ancestorFlags.booleanFlags,
      ancestorFlags.valueFlags,
    );
    if (consumed > 0) {
      i += consumed;
      continue;
    }
    if (arg === subcommandName) {
      subcommandIndex = i;
      break;
    }
    break;
  }
  if (subcommandIndex === -1) {
    return argv;
  }

  // Walk tokens after the subcommand, hoisting ancestor options before it and
  // leaving the subcommand's own options and positionals in place.
  const hoisted: string[] = [];
  const remaining: string[] = [];
  let sawTerminator = false;
  for (let j = subcommandIndex + 1; j < argv.length; j += 1) {
    const arg = argv[j];
    if (sawTerminator || arg === "--") {
      if (arg === "--") {
        sawTerminator = true;
      }
      remaining.push(arg);
      continue;
    }
    const consumed = consumeHoistableOption(
      argv,
      j,
      ancestorFlags.booleanFlags,
      ancestorFlags.valueFlags,
    );
    if (consumed > 0) {
      for (let k = 0; k < consumed; k += 1) {
        hoisted.push(argv[j + k]);
      }
      j += consumed - 1;
      continue;
    }
    remaining.push(arg);
  }

  if (hoisted.length === 0) {
    return argv;
  }
  return [...argv.slice(0, subcommandIndex), ...hoisted, subcommandName, ...remaining];
}
