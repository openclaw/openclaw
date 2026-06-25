// Setup command registration: keep `setup` as an alias for canonical onboarding.
import type { Command } from "commander";
import { registerOnboardCommand } from "./register.onboard.js";

/**
 * Product contract: `setup` is the documented alias for canonical onboarding.
 * Bare `--skip-ui` preserves the baseline initializer for scripting compatibility.
 */
export function registerSetupCommand(program: Command): void {
  registerOnboardCommand(program, {
    commandName: "setup",
    description: "Alias for openclaw onboard",
    docsPath: "/cli/setup",
  });
}
