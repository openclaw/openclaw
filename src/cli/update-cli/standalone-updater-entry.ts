import "../../infra/sealed-runtime-bootstrap.js";
import { registerUpgradeRecipeRunnerProcesses } from "../../infra/upgrade-recipes/runner-processes.js";

registerUpgradeRecipeRunnerProcesses(new URL("./", import.meta.url));

// This entry belongs to the verified, dependency-closed retained bundle, never
// to discovery of the installation being replaced. It does not import its CLI.
try {
  const { runUpgradeRecipeCommand } = await import("./recipe-command.js");
  await runUpgradeRecipeCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Upgrade recipe runner failed: ${error instanceof Error ? error.message : "unknown failure"}. No successful completion was recorded.\n`,
  );
  process.exitCode = 1;
}
