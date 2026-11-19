import type { SessionAccessScope } from "./session-accessor.types.js";
import type { SessionMessageCutIntent } from "./session-message-cut.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Settle the source before the transcript fences its incarnation, without creating a projection. */
export async function prepareMessageCutLocalWorkspace(
  scope: SessionAccessScope & { agentId: string },
  entry: InternalSessionEntry,
  assertCurrent: () => void,
): Promise<SessionMessageCutIntent["settledLocalWorkspace"]> {
  if (!entry.worktree) {
    return undefined;
  }
  const { resolveLocalWorkspaceOwner, withSettledLocalWorkspace } =
    await import("../../gateway/worker-environments/local-workspace-projection.js");
  using owner = await resolveLocalWorkspaceOwner({
    cfg: {},
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    env: scope.env,
    assertCurrent,
  });
  if (
    !owner ||
    owner.worktree.id !== entry.worktree.id ||
    owner.sessionId !== entry.sessionId ||
    owner.lifecycleRevision !== (entry.lifecycleRevision ?? null)
  ) {
    throw new Error("Session changed before local workspace history-cut settlement");
  }
  return await withSettledLocalWorkspace(
    { ...owner, sessionOwner: owner, retireRuntime: true },
    async (custody) => {
      owner.assertCurrent();
      return custody?.projectionRevision === undefined
        ? undefined
        : {
            worktreeId: owner.worktree.id,
            sessionId: owner.sessionId,
            lifecycleRevision: owner.lifecycleRevision,
            projectionRevision: custody.projectionRevision,
          };
    },
  );
}
