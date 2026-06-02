export const FLAG_TERMINATOR = "--";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);

/** Returns whether a token can be consumed as a root option value. */
export function isValueToken(arg: string | undefined): boolean {
  if (!arg || arg === FLAG_TERMINATOR) {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  // Numeric values may be negative; treat them as option values instead of
  // accidentally leaving them for downstream command parsing as flags.
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

/** Returns how many argv tokens belong to a recognized root-level option. */
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (ROOT_VALUE_FLAGS.has(arg)) {
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
}
