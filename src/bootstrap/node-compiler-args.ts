// Preserve explicit operator or tooling compiler policy; production uses Node defaults.
const COMPILER_FLAGS = new Set([
  "--no-maglev",
  "--maglev",
  "--no-concurrent-sparkplug",
  "--concurrent-sparkplug",
]);

/** Forward explicit compiler policy into OpenClaw-owned Node workers. */
export function resolveForwardedNodeCompilerArgs(
  execArgv: readonly string[] = process.execArgv,
): string[] {
  return execArgv.filter((arg) => COMPILER_FLAGS.has(arg.replaceAll("_", "-")));
}
