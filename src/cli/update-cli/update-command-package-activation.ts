import { capturePackageActivationRuntime } from "../../infra/package-update-activation-paths.js";
import type { PackageActivationRuntime } from "../../infra/package-update-swap-contract.js";
import { defaultRuntime } from "../../runtime.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";

export function createPackageUpdateActivationOptions(params: {
  run: MutableUpdateExecutionParams["opts"]["run"];
  runtime?: PackageActivationRuntime;
  assertCurrent: () => void;
}): Pick<PackageInstallUpdateParams, "reserveInstallSlot" | "getActivation"> {
  return {
    reserveInstallSlot: (root) => {
      params.assertCurrent();
      const fence = params.run?.executorFence;
      if (fence) {
        reserveUpdateCommandExecutorSlot(fence, root);
      }
    },
    getActivation: () => {
      const run = params.run;
      const fence = run?.executorFence;
      return run && fence
        ? {
            fence,
            runtime:
              params.runtime ??
              capturePackageActivationRuntime(
                process.versions.bun ? "bun" : "node",
                process.execPath,
              ),
            onPrepared: (command: string) => {
              params.assertCurrent();
              defaultRuntime.error(
                `Package publication recovery: ${command}\nKeep other package managers stopped; repair may republish a missing installation. Recovery does not restart or verify the Gateway.`,
              );
            },
            onUnavailable: (message: string) => {
              params.assertCurrent();
              defaultRuntime.error(message);
            },
          }
        : undefined;
    },
  };
}
