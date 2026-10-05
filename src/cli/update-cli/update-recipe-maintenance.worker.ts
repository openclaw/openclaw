import { routeLogsToStderr } from "../../logging/console.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput, runCliWithExitFinalization } from "../one-shot-exit.js";
import { withCliCommandCleanup, withCliProcessScope } from "../runtime-cleanup-scope.js";
import { closeCliResources, waitForPendingCliDisposers } from "../runtime-cleanup.js";
import { UPDATE_RECIPE_MAINTENANCE_CAPABILITY } from "./update-recipe-maintenance-contract.js";

async function runReceiver(): Promise<void> {
  routeLogsToStderr();
  if (process.argv.length !== 3 || !["--check", "--run"].includes(process.argv[2] ?? "")) {
    throw new Error("Upgrade maintenance receiver requires an explicit private capability mode.");
  }
  if (process.argv[2] === "--check") {
    // No grant consumption, Gateway import, config loading, or installed startup hooks.
    process.stdout.write(
      `${JSON.stringify({ capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY })}\n`,
    );
    exitCliAfterOutput(defaultRuntime, 0);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1024 * 1024) {
      throw new Error("Upgrade maintenance private input exceeds its bound.");
    }
    chunks.push(buffer);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      try {
        const { runUpdateRecipeMaintenanceReceiver } =
          await import("./update-recipe-maintenance.js");
        const result = await runUpdateRecipeMaintenanceReceiver(raw);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        await closeCliResources(cleanup);
        await cleanup?.pluginResources?.release();
      }
    }),
  );
  exitCliAfterOutput(defaultRuntime, 0);
}

void runCliWithExitFinalization({
  run: runReceiver,
  finalize: waitForPendingCliDisposers,
  onError(error) {
    process.stdout.write(
      `${JSON.stringify({
        capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
        outcome: "recovery-required",
        processSettlement: hasCommandProcessCleanupError(error)
          ? "uncertain"
          : "no-uncertainty-reported",
      })}\n`,
    );
    // Private transport/custody failures can contain configuration or path details.
    defaultRuntime.error(
      "Upgrade maintenance receiver failed; original recovery ownership and current state are preserved.",
    );
    process.exitCode = 1;
  },
});
