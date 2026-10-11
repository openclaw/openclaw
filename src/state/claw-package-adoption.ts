import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

export type ClawPackageAdoption = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version?: string;
  workspace?: string;
};

/** Records an explicit non-Claw claim through the canonical package owner. */
export async function markClawPackageIndependentlyOwned(
  artifact: ClawPackageAdoption,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<number> {
  try {
    return (
      (await runOpenClawStateWorkerOperation(
        captureOpenClawStateWorkerContext(options),
        (scope) =>
          scope.execute({
            type: "clawAdoption.package",
            input: { artifact, nowMs: options.nowMs ?? Date.now() },
          }),
        { existingOnly: true },
      )) ?? 0
    );
  } catch {
    // The canonical install already succeeded. Removal also checks its newer owner timestamp.
    return 0;
  }
}
