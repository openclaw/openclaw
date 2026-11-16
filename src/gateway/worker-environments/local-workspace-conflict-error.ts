/** Safe to disclose: never includes paths, file contents, or an internal cause. */
export class LocalWorkspaceConflictError extends Error {
  constructor() {
    super(
      "Local sandbox edits conflict with the managed workspace; pending changes were preserved. Resolve the workspace conflicts before retrying.",
    );
    this.name = "LocalWorkspaceConflictError";
  }
}
