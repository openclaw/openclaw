import { formatErrorMessage } from "../../infra/errors.js";
import { capturePackageActivationRuntime } from "../../infra/package-update-activation-paths.js";
import type { PackageActivationRuntime } from "../../infra/package-update-activation-runtime.types.js";
import {
  assertNoPendingPackageActivation,
  settlePendingPackageActivation,
} from "../../infra/package-update-activation.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { defaultRuntime } from "../../runtime.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

function pendingPackageActivation(root: string, cause: unknown): never {
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

/** Settle lost lease custody before admission, including previews; never restart a service. */
export async function prepareUpdatePackageActivationAdmission(
  root: string,
  options?: Parameters<typeof assertUpdatePackageActivationAdmission>[1],
): Promise<void> {
  const roots = options?.serviceRoot ? [root, options.serviceRoot] : [root];
  for (const selected of new Set(roots)) {
    if (!options?.continuation) {
      try {
        const settled = await settlePendingPackageActivation(
          resolveUpdateInstallRoot(selected),
          (settlement) => {
            defaultRuntime.error(
              `Warning: previous package update operation ${settlement.operationId} closed as ${settlement.reason}. Recovery evidence retained at ${settlement.retained}.${settlement.detail ? ` ${settlement.detail}` : ""}`,
            );
          },
          undefined,
          { onlyStaleLease: true },
        );
        if (settled?.warning) {
          defaultRuntime.error(`Warning: ${settled.warning}`);
        }
      } catch (cause) {
        pendingPackageActivation(selected, cause);
      }
    }
    assertUpdatePackageActivationAdmission(selected, { continuation: options?.continuation });
  }
}

/** Package admission must not open history or launch diagnostics on a retained operation. */
export function assertUpdatePackageActivationAdmission(
  root: string,
  options?: Parameters<typeof assertNoPendingPackageActivation>[1] & { serviceRoot?: string },
): void {
  try {
    assertNoPendingPackageActivation(resolveUpdateInstallRoot(root), options);
  } catch (cause) {
    pendingPackageActivation(root, cause);
  }
  // A retained publication still owns the service installation when the CLI updates another root.
  if (options?.serviceRoot && options.serviceRoot !== root) {
    assertUpdatePackageActivationAdmission(options.serviceRoot, {
      continuation: options.continuation,
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
