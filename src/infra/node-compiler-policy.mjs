const FORWARDED_COMPILER_FLAGS = new Set([
  "--maglev",
  "--no-maglev",
  "--concurrent-sparkplug",
  "--no-concurrent-sparkplug",
]);

/** Preserve compiler policy without replaying parent loaders, evals, or debuggers. */
export function resolveForwardedNodeCompilerArgs(execArgv = process.execArgv) {
  return execArgv.filter((arg) => FORWARDED_COMPILER_FLAGS.has(arg.replaceAll("_", "-")));
}
