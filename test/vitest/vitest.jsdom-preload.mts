import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

// Vitest 5 starts these four packaged workers. Descendants inherit execArgv,
// but ordinary forks/threads must not load a test runtime or alter their IPC.
const entrypoint = process.argv[1]?.replaceAll("\\", "/");
if (/\/vitest\/dist\/workers\/(?:forks|threads|vmForks|vmThreads)\.js$/u.test(entrypoint ?? "")) {
  // Match the active worker's instance, including package-local pnpm peer graphs.
  const require = process.getBuiltinModule("module").createRequire(process.argv[1]!);
  const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");
  installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
}
