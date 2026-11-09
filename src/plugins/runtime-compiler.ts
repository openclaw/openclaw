import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** One-shot compilers are reaped by their caller; no service or sync-API worker survives. */
export function pluginCompilerCommand(): [string, ...string[]] {
  const binary = require.resolve("esbuild/bin/esbuild");
  return process.platform === "win32" ? [process.execPath, binary] : [binary];
}
