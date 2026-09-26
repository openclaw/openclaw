import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import type { FleetContainerInspectResult, FleetContainerRuntime } from "./containers.runtime.js";
import type { FleetCellRecord } from "./registry.js";
import { assertManagedInspection } from "./service-support.runtime.js";

export function missingContainerRecoveryHint(
  record: Pick<FleetCellRecord, "tenantId" | "runtime">,
): string {
  return `remove the stale registration without purging data (openclaw fleet rm ${record.tenantId} --force), under the same original OS user and group identity and the same Docker or Podman rootless/rootful context, recreate a stopped cell with the original full provisioning profile (openclaw fleet create ${record.tenantId} --runtime ${record.runtime} --image <image> --port <port> --memory <memory> --cpus <cpus> --pids-limit <pids-limit> --network <bridge|internal> [--disk <disk>] [--env KEY=VALUE ...] --no-start; replace every placeholder with the original value, omit only options that were not originally set, and if any value is unknown recover it from the original provisioning command or deployment record before continuing; do not use create defaults), then retry fleet restore`;
}

export async function recoverStoppedFleetCellAfterRestoreFailure(params: {
  record: FleetCellRecord;
  containers: FleetContainerRuntime;
  containerId: string;
  checkpoint: () => Promise<void>;
  originalError: unknown;
}): Promise<void> {
  let missingContainerError: Error | undefined;
  try {
    // Keep the inspected identity pinned so a replacement that claims the cell
    // name cannot be started as if it were the stopped cell.
    const currentInspection = await params.containers.inspect(
      params.record.runtime,
      params.containerId,
    );
    if (currentInspection.kind === "missing") {
      // The old ID is gone; inspect the registered name only for diagnostics.
      // A name match is never enough to authorize starting another generation.
      let namedInspection: FleetContainerInspectResult;
      try {
        namedInspection = await params.containers.inspect(
          params.record.runtime,
          params.record.containerName,
        );
      } catch {
        namedInspection = {
          kind: "unavailable",
          state: "unknown",
          error: "container name inspection failed",
        };
      }
      const nameLookupGuidance =
        namedInspection.kind === "missing"
          ? ` The registered cell name is also missing; ${missingContainerRecoveryHint(params.record)}.`
          : namedInspection.kind === "ok"
            ? " A container still uses the registered cell name and was left untouched. Do not run the missing-container removal or create sequence while that name is occupied. Identify and preserve the container, resolve the name conflict without deleting it, then retry fleet restore."
            : " The registered cell name could not be checked, so no container was started. Do not run the missing-container removal or create sequence until you verify that the registered name is free.";
      missingContainerError = new Error(
        `${errorMessage(params.originalError)}. The previous cell container is missing.${nameLookupGuidance}`,
        { cause: params.originalError },
      );
    } else {
      const current = assertManagedInspection(params.record, currentInspection);
      if (!current.running) {
        await params.checkpoint();
        await params.containers.start(params.record.runtime, current.containerId);
      }
    }
  } catch {
    if (missingContainerError) {
      throw missingContainerError;
    }
    throw new Error(
      `${errorMessage(params.originalError)}. The previous cell could not be restarted or verified; run \`openclaw fleet start ${params.record.tenantId}\` before retrying fleet restore.`,
      { cause: params.originalError },
    );
  }
  if (missingContainerError) {
    throw missingContainerError;
  }
}
