class WorkerWorkspacePreflightError extends Error {
  readonly code = "invalid_state";

  constructor(message: string) {
    super(message);
    this.name = "WorkerWorkspacePreflightError";
  }
}

export const workspaceInventoryError = (message: string): Error =>
  new WorkerWorkspacePreflightError(message);
