import { builtinEnvironments } from "vitest/runtime";
import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

// Run before Vitest initializes its environment, including explicit jsdom pragmas.
installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
