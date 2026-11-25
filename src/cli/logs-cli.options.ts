import { parseOptionalPositiveInteger } from "./parse-positive-integer.js";

export function parseLogsPositiveInt(value: unknown, fallback: number, flag: string): number {
  return parseOptionalPositiveInteger(value, flag, ".") ?? fallback;
}
