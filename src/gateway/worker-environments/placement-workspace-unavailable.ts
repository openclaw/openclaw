export class WorkerPlacementWorkspaceUnavailableError extends Error {
  constructor(
    message: string,
    readonly target: {
      sessionKey: string;
      agentId: string;
      storePath: string;
      worktreeId?: string;
    },
  ) {
    super(message);
  }
}
