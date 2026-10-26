import { readRegistryWorktree } from "../../agents/worktrees/registry-read.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withSettledLocalWorkspace } from "./local-workspace-projection.js";

/** Sandbox recreate recovers through the existing canonical projection owner, including after a controller crash. */
export async function withSettledLocalWorkspaceProjectionPath<T>(
  params: {
    projectionPath: string;
    databasePath?: string;
    env?: NodeJS.ProcessEnv;
    requireProjection?: boolean;
    assertCurrent?: () => void;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext({ path: params.databasePath, env: params.env });
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "localWorkspace.byProjectionPath", input: { projectionPath: params.projectionPath } },
    { context, current: true },
  );
  params.assertCurrent?.();
  if (!reply) {
    if (params.requireProjection) {
      throw new Error("Managed sandbox projection is missing; preserve its stopped custody.");
    }
    return await operation();
  }
  if (!reply.ok || reply.type !== "localWorkspace.byProjectionPath") {
    throw new Error("Unexpected local workspace projection lookup.");
  }
  if (!reply.projection) {
    if (params.requireProjection) {
      throw new Error("Managed sandbox projection is missing; preserve its stopped custody.");
    }
    return await operation();
  }
  const worktree = await readRegistryWorktree(context, reply.projection.worktree_id);
  params.assertCurrent?.();
  if (!worktree) {
    throw new Error(
      "Managed sandbox workspace lost its canonical owner; preserve its stopped custody.",
    );
  }
  return await withSettledLocalWorkspace(
    { worktree, env: context.environment, assertCurrent: params.assertCurrent },
    operation,
  );
}
