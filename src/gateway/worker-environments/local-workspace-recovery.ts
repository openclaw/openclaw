import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root } from "../../infra/fs-safe.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./local-workspace-projection.js";
import { manifestPath, MAX_RECONCILIATION_FILE_BYTES } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import { hasWorkerWorkspaceResultRef } from "./workspace-result-staging.js";

/** Explicit operator recovery, before settlement: never discard or ignore a guest file. */
export async function recoverLocalWorkspaceFile(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  path: string;
  recoveryId: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ path: string; bytes: number }> {
  const selectedPath = manifestPath(params.path);
  if (
    selectedPath.split("/").some((part) => part.toLowerCase() === ".git") ||
    isDerivedWorkspacePath(selectedPath) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      params.recoveryId,
    )
  ) {
    throw new Error("Select a retained workspace file and a UUID recovery ID");
  }
  using owner = await resolveLocalWorkspaceOwner({
    cfg: params.cfg,
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    env: params.env,
    assertCurrent: params.assertCurrent,
  });
  if (!owner) {
    throw new Error("Session has no local managed workspace to recover");
  }
  return await withLocalWorkspaceProjection(
    owner,
    async (state) => {
      const current = () => {
        params.signal?.throwIfAborted();
        return state.current();
      };
      const selected = current();
      const stateRoot = await root(resolveStateDir(owner.env), {
        symlinks: "reject",
        mutationSymlinks: "reject",
        hardlinks: "reject",
        assertBeforeMutation: current,
      });
      const source =
        path.relative(stateRoot.rootReal, selected.projection_path) + "/" + selectedPath;
      // Outside projection expiry as well as synchronization. The operator owns these
      // named recovery artifacts; no automatic retention/deletion policy is added.
      const destination =
        "workspace-recovery/" + owner.worktree.id + "/" + params.recoveryId + "/" + selectedPath;
      const recoveredPath = path.join(stateRoot.rootReal, destination);
      const result = async () => {
        await using file = await stateRoot.open(destination);
        current();
        return { path: recoveredPath, bytes: file.stat.size };
      };
      // A lost response may follow a completed move. Never overwrite a recovery or
      // replay removal when both names survive a partial filesystem operation.
      if (await stateRoot.exists(destination)) {
        if (await stateRoot.exists(source)) {
          throw new Error("Both file names exist; inspect retained artifact at " + recoveredPath);
        }
        return await result();
      }
      if (
        selected.journal_json ||
        !selected.pending_ref ||
        selected.pending_target !== "canonical" ||
        (await hasWorkerWorkspaceResultRef({
          root: owner.worktree.repoRoot,
          stagedResultRef: selected.pending_ref,
        }))
      ) {
        throw new Error(
          "Recovery requires an unstaged guest checkpoint; existing receipts were preserved",
        );
      }
      const canonical = await state.canonicalPaths();
      if (canonical.has(selectedPath)) {
        throw new Error(
          "Cannot relocate a source file already admitted to the canonical workspace",
        );
      }
      await using file = await stateRoot.open(source);
      if (file.stat.size <= MAX_RECONCILIATION_FILE_BYTES) {
        throw new Error("Selected file does not exceed the 64 MiB reconciliation limit");
      }
      await stateRoot.mkdir(path.dirname(destination), { private: true });
      current();
      try {
        await stateRoot.move(source, destination);
      } catch (error) {
        // Filesystem rejection after dispatch may have preserved either/both names.
        // Always disclose the stable recovery path, never infer non-publication.
        throw new Error(
          "Recovery move did not finish; inspect " + recoveredPath + " before retrying",
          { cause: error },
        );
      }
      current();
      return { path: recoveredPath, bytes: file.stat.size };
    },
    { signal: params.signal },
  );
}
