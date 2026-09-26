import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner } from "./shared.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";

export function createPackageUpdateActivationOptions(params: {
  run: MutableUpdateExecutionParams["opts"]["run"];
  nodeRunner?: string;
  assertCurrent: () => void;
}): Pick<PackageInstallUpdateParams, "reserveInstallSlot" | "activation"> {
  return {
    reserveInstallSlot: (root) => {
      params.assertCurrent();
      const fence = params.run?.executorFence;
      if (fence) {
        reserveUpdateCommandExecutorSlot(fence, root);
      }
    },
    get activation() {
      const run = params.run;
      const fence = run?.executorFence;
      return run && fence
        ? {
            runId: run.runId,
            fence,
            nodeRunner: params.nodeRunner ?? resolveNodeRunner(),
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
