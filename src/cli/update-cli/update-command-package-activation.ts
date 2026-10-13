import { formatErrorMessage } from "../../infra/errors.js";
import { capturePackageActivationRuntime } from "../../infra/package-update-activation-paths.js";
import type { PackageActivationRuntime } from "../../infra/package-update-activation-runtime.types.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { defaultRuntime } from "../../runtime.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

/** Package admission must not open history or launch diagnostics on a retained operation. */
export function assertUpdatePackageActivationAdmission(
  root: string,
  options?: Parameters<typeof assertNoPendingPackageActivation>[1] & { serviceRoot?: string },
): void {
  try {
    assertNoPendingPackageActivation(resolveUpdateInstallRoot(root), options);
  } catch (cause) {
    const message = formatErrorMessage(cause);
    throw new UpdateCommandPendingRecoveryFailure(
      {
        status: "error",
        mode: "unknown",
        root,
        reason: "update-recovery-pending",
        steps: [
          {
            name: "update-recovery-pending",
            command: "openclaw update",
            cwd: root,
            durationMs: 0,
            exitCode: 1,
            diagnostics: [message],
          },
        ],
        durationMs: 0,
      },
      message,
      { cause },
    );
  }
  // A retained publication still owns the service installation when the CLI updates another root.
  if (options?.serviceRoot && options.serviceRoot !== root) {
    assertUpdatePackageActivationAdmission(options.serviceRoot, {
      continuation: options.continuation,
      dryRun: options.dryRun,
    });
  }
}

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
