import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function readRegistryWorktrees(
  env: NodeJS.ProcessEnv,
): Promise<ManagedWorktreeRecord[]> {
  const context = captureOpenClawStateWorkerContext({ env });
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.list", input: undefined });
}
