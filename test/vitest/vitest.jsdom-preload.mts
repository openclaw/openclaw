import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

// Match the worker's Vitest instance, including package-local pnpm peer graphs.
const require = process.getBuiltinModule("module").createRequire(process.argv[1]!);
const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");
installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
