import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

/** Records an explicit non-Claw claim through the canonical MCP owner. */
export async function markClawMcpServerIndependentlyOwned(
  name: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<number> {
  try {
    return (
      (await runOpenClawStateWorkerOperation(
        captureOpenClawStateWorkerContext(options),
        (scope) =>
          scope.execute({
            type: "clawAdoption.mcp",
            input: { name, nowMs: options.nowMs ?? Date.now() },
          }),
        { existingOnly: true },
      )) ?? 0
    );
  } catch {
    // The canonical MCP write already succeeded; Claw status still detects config drift.
    return 0;
  }
}
