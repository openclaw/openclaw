import type { SessionAccessScope } from "./session-accessor.types.js";
import { selectSessionMessageCut } from "./session-message-cut-plan.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import type { InternalSessionEntry } from "./types.js";

/** Validate before retirement and settle the source before the transcript fences its incarnation. */
export async function prepareMessageCutLocalWorkspace(
  scope: SessionAccessScope & { agentId: string },
  entry: InternalSessionEntry,
  assertCurrent: () => void,
  cut?: { intent: SessionMessageCutIntent; sourceRepositoryWorkspaceId?: string },
): Promise<
  | { status: "settled"; workspace: SessionMessageCutIntent["settledLocalWorkspace"] }
  | Exclude<SessionMessageCutResult, { status: "created" }>
> {
  if (!entry.worktree) {
    return { status: "settled", workspace: undefined };
  }
  if (cut) {
    cut.intent.expectedState ??= {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    };
    const events = await loadSessionTranscriptEvents({ ...scope, sessionId: entry.sessionId });
    assertCurrent();
    const selected = selectSessionMessageCut(
      entry,
      events,
      cut.intent,
      cut.sourceRepositoryWorkspaceId,
    );
    if (selected.status !== "selected") {
      return selected;
    }
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
  const workspace = await withSettledLocalWorkspace(
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
  return { status: "settled", workspace };
}
