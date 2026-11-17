import path from "node:path";
import {
  resolveSessionWorkspaceCandidatePath,
  setSessionWorkspaceFile,
} from "./workspace-files.js";

export type ManagedSessionFileWrite = Awaited<ReturnType<typeof setSessionWorkspaceFile>>;

/**
 * Saves a Files edit for a managed worktree. The selected workspace-relative
 * candidate is bound through the write, and an accepted conflict is
 * acknowledged through projection custody before the sync is attempted.
 */
export async function writeSessionFileWithConflictRecovery(params: {
  root: string;
  fileRoot?: string;
  worktreeId: string;
  requestedPath: string;
  content: string;
  expectedHash: string;
  assertCurrent: () => void;
}): Promise<{ update: ManagedSessionFileWrite; acknowledgedInCustody: boolean }> {
  const { root, fileRoot, worktreeId, requestedPath, content, expectedHash, assertCurrent } =
    params;
  const write = (assert: () => void, hash: string, targetPath: string) =>
    setSessionWorkspaceFile({
      root,
      fileRoot,
      path: targetPath,
      content,
      expectedHash: hash,
      assertCurrent: assert,
    });
  const candidateBrowserPath = await resolveSessionWorkspaceCandidatePath({
    root,
    fileRoot,
    filePath: requestedPath,
  });
  const effectivePath = candidateBrowserPath ?? requestedPath;
  // The candidate is workspace-relative. Hand the writer an absolute path so it
  // does not apply fileRoot a second time when that candidate is nested.
  const writePath = candidateBrowserPath ? path.join(root, candidateBrowserPath) : requestedPath;
  const { withSettledLocalWorkspacePath } =
    await import("../worker-environments/local-workspace-projection.js");
  const { resolveReconciledExpectedHash, acknowledgeLocalWorkspaceConflict } =
    await import("../worker-environments/local-workspace-conflict-acknowledgement.js");
  const { LocalWorkspaceConflictError } =
    await import("../worker-environments/local-workspace-conflict-error.js");
  let acknowledgedInCustody = false;
  const update = await withSettledLocalWorkspacePath(
    { cwd: root, assertCurrent, allowConflict: true },
    async (custody) => {
      const currentAuth = () => {
        assertCurrent();
        custody?.assertCurrent();
      };
      const { effectiveExpectedHash, reviewedGuestVersion } = await resolveReconciledExpectedHash({
        cwd: root,
        fileRoot,
        path: effectivePath,
        expectedHash,
        projectionPath: custody?.projectionPath,
        conflicts: custody?.conflicts,
        assertCurrent: currentAuth,
      });
      const written = await write(currentAuth, effectiveExpectedHash ?? expectedHash, writePath);
      if (written.status === "updated") {
        if (candidateBrowserPath) {
          // Report the workspace-relative candidate, never the host path used to write.
          written.file.path = candidateBrowserPath;
        }
        if (written.file.workspacePath) {
          if (custody?.acknowledgeConflict) {
            await custody.acknowledgeConflict(written.file.workspacePath, reviewedGuestVersion);
          } else {
            await acknowledgeLocalWorkspaceConflict({
              cwd: root,
              worktreeId,
              path: written.file.workspacePath,
              reviewedGuestVersion,
              assertCurrent: currentAuth,
            });
          }
          acknowledgedInCustody = true;
        }
        try {
          await custody?.synchronizeProjection?.();
        } catch (error) {
          // This save's accepted bytes are durable even when other paths remain
          // conflicted; report that outcome instead of failing.
          if (!(error instanceof LocalWorkspaceConflictError)) {
            throw error;
          }
        }
      }
      return written;
    },
  );
  return { update, acknowledgedInCustody };
}
