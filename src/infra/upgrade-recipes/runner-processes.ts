import { runtimeProcessEntrypoints } from "../runtime-process-entrypoints.js";
import { registerSealedRuntimeProcessEntrypoint } from "../runtime-process-url.js";
import { upgradeRecipeRunnerProcessNames } from "./runner-process-contract.js";

/** Called before any worker entry executes; no environment-selected installation fallback. */
export function registerUpgradeRecipeRunnerProcesses(root: URL): void {
  for (const name of upgradeRecipeRunnerProcessNames) {
    registerSealedRuntimeProcessEntrypoint(
      name,
      new URL(runtimeProcessEntrypoints[name].distWorkerPath.replace(/\.js$/u, ".mjs"), root),
    );
  }
}
