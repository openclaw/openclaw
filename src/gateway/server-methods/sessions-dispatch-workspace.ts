import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerSessionWorkspace } from "../worker-environments/session-workspace.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type { RespondFn } from "./types.js";

export function respondInvalidWorkerSession(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export async function resolveSessionWorkspace(params: {
  entry: NonNullable<ReturnType<typeof loadAccessorSessionEntryForGatewayTarget>["entry"]>;
  sessionKey: string;
  agentId: string;
  method: "sessions.dispatch" | "sessions.move" | "sessions.reclaim";
  respond: RespondFn;
}): Promise<WorkerSessionWorkspace | undefined> {
  if (params.entry.repositoryWorkspaceId) {
    const repository = await getSessionRepositoryWorkspaceStore().get(
      params.entry.repositoryWorkspaceId,
    );
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
    if (
      current.agentId === params.agentId &&
      current.canonicalKey === params.sessionKey &&
      current.entry?.sessionId === params.entry.sessionId &&
      current.entry?.lifecycleRevision === params.entry.lifecycleRevision &&
      current.entry?.archivedAt === params.entry.archivedAt &&
      current.entry?.repositoryWorkspaceId === params.entry.repositoryWorkspaceId &&
      !current.entry.worktree &&
      repository &&
      repository.agentId === params.agentId &&
      repository.sessionKey === params.sessionKey &&
      !params.entry.worktree
    ) {
      return { kind: "repository", repository };
    }
    respondInvalidWorkerSession(params.respond, "The session repository workspace owner changed.");
    return undefined;
  }
  const worktree = managedWorktrees.findLiveByOwner("session", params.sessionKey);
  if (
    params.entry.worktree?.id &&
    worktree &&
    worktree.id === params.entry.worktree.id &&
    worktree.ownerId === params.sessionKey
  ) {
    return { kind: "local", path: worktree.path };
  }
  const article = params.method === "sessions.dispatch" ? "a" : "the";
  respondInvalidWorkerSession(
    params.respond,
    `${params.method} requires ${article} session-owned worktree or repository workspace`,
  );
  return undefined;
}
