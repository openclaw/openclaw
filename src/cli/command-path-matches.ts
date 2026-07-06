// Shared command-path matching helpers for CLI startup and registration policy.
import { getCommandPositionalsWithRootOptions } from "./argv.js";

/** Matches a command path prefix, or the full path when `exact` is requested. */
export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}

/** Matches a raw argv command path while consuming known command option values. */
export function matchesArgvCommandPath(
  argv: string[],
  pattern: readonly string[],
  params?: {
    exact?: boolean;
    booleanFlags?: readonly string[];
    valueFlags?: readonly string[];
  },
): boolean {
  const positionals = getCommandPositionalsWithRootOptions(argv, {
    commandPath: pattern,
    booleanFlags: params?.booleanFlags,
    valueFlags: params?.valueFlags,
  });
  if (positionals === null) {
    return false;
  }
  return !params?.exact || positionals.length === 0;
}
