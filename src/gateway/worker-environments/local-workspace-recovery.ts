import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root, type Root } from "../../infra/fs-safe.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { shellEscape } from "../../shared/shell-quote.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./local-workspace-projection.js";
import type { projectionOperations } from "./local-workspace-state.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { OVERSIZED_WORKSPACE_FILE_ERROR_PREFIX } from "./workspace-manifest-comparison.js";
import { manifestPath, MAX_RECONCILIATION_FILE_BYTES } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import { hasWorkerWorkspaceResultRef } from "./workspace-result-staging.js";

type RecoveryState = Pick<ReturnType<typeof projectionOperations>, "current" | "canonicalPaths">;

function recoveryPath(value: string) {
  const selectedPath = manifestPath(value);
  if (
    selectedPath.split("/").some((part) => part.toLowerCase() === ".git") ||
    isDerivedWorkspacePath(selectedPath)
  ) {
    throw new Error("Select a retained workspace file and a UUID recovery ID");
  }
  return selectedPath;
}

async function openRecoverableFile(
  owner: LocalWorkspaceOwner,
  state: RecoveryState,
  stateRoot: Root,
  selectedPath: string,
) {
  const selected = state.current();
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
  if ((await state.canonicalPaths()).has(selectedPath)) {
    throw new Error("Cannot relocate a source file already admitted to the canonical workspace");
  }
  const source = path.relative(stateRoot.rootReal, selected.projection_path) + "/" + selectedPath;
  const file = await stateRoot.open(source);
  if (file.stat.size <= MAX_RECONCILIATION_FILE_BYTES) {
    await file[Symbol.asyncDispose]();
    throw new Error("Selected file does not exceed the 64 MiB reconciliation limit");
  }
  return file;
}

/** Advice uses the same eligibility checks as relocation, under the existing workspace lease. */
export async function describeLocalWorkspaceRecovery(
  error: Error,
  owner: LocalWorkspaceOwner,
  state: RecoveryState,
): Promise<Error> {
  try {
    // Worker errors retain their message but not custom fields. Only the shared
    // size-error prefix is decoded; the recovery owner validates the path again.
    const selectedPath = recoveryPath(
      error.message.slice(OVERSIZED_WORKSPACE_FILE_ERROR_PREFIX.length),
    );
    const stateRoot = await root(resolveStateDir(owner.env), {
      symlinks: "reject",
      hardlinks: "reject",
    });
    const file = await openRecoverableFile(owner, state, stateRoot, selectedPath);
    await file[Symbol.asyncDispose]();
    state.current();
    return new Error(
      error.message +
        "\nPending workspace changes were preserved. Ask a Gateway administrator to run:\n" +
        `openclaw sandbox recover --session ${shellEscape(owner.sessionKey)} --path ${shellEscape(selectedPath)}` +
        "\nRun this command in Bash or zsh on the Gateway host, then retry the session. The selected file is preserved outside workspace synchronization.",
      { cause: error },
    );
  } catch {
    // Ineligible or no longer inspectable files must not advertise a recovery
    // command. Leave the original failure and all pending bytes untouched.
    return error;
  }
}

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
  const selectedPath = recoveryPath(params.path);
  if (
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
      await using file = await openRecoverableFile(owner, state, stateRoot, selectedPath);
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
