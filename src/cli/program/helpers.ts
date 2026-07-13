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
export function resolveCommandOptionArgs(command: Command): string[] {
  const out: string[] = [];
  for (const option of command.options) {
    const name = option.attributeName();
    if (command.getOptionValueSource(name) === "default") {
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
