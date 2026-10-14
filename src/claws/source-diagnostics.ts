import { FsSafeError } from "../infra/fs-safe.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export function clawWorkspaceSourceFailure(
  error: unknown,
  sourcePath: string,
  context: "package" | "source",
) {
  if (error instanceof FsSafeError && error.code === "too-large") {
    return {
      code: "workspace_source_too_large",
      message: `Workspace source ${JSON.stringify(sourcePath)} exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
    };
  }
  if (
    (error instanceof FsSafeError &&
      (error.code === "symlink" || error.code === "hardlink" || error.code === "path-mismatch")) ||
    (error instanceof Error && error.message.includes("symlinked directory"))
  ) {
    return {
      code: "workspace_source_unsafe",
      message: `Workspace source ${JSON.stringify(sourcePath)} must be a regular, non-symlinked, non-hardlinked file.`,
    };
  }
  return {
    code: "workspace_source_invalid",
    message:
      context === "package"
        ? `Workspace source ${JSON.stringify(sourcePath)} must resolve to a file inside the Claw package.`
        : `Workspace source ${JSON.stringify(sourcePath)} must resolve inside the Claw source.`,
  };
}
