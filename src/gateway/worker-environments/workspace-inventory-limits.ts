export const MAX_WORKSPACE_INVENTORY_ENTRIES = 250_000;
export const MAX_WORKSPACE_GIT_CANDIDATES = MAX_WORKSPACE_INVENTORY_ENTRIES * 4;
export const MAX_WORKSPACE_INVENTORY_PATH_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export const WORKSPACE_RESULT_LIMIT_ERROR_CODE = "WORKSPACE_RESULT_LIMIT";

export class WorkspaceResultLimitError extends Error {
  readonly code = WORKSPACE_RESULT_LIMIT_ERROR_CODE;

  constructor(message: string) {
    super(
      `${message} Remove generated dependencies/build output from Git tracking and add it to .gitignore, exclude it from the workspace, or split intentional changes before retrying. Saved workspace files were preserved.`,
    );
  }
}
