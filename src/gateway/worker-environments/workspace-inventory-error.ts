export const workspaceInventoryError = (message: string): Error =>
  Object.assign(new Error(message), {
    code: "invalid_state",
    name: "WorkerWorkspacePreflightError",
  });
