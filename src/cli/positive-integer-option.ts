import { InvalidArgumentError } from "commander";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

export function parsePositiveIntegerOption(value: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return parsed;
}
