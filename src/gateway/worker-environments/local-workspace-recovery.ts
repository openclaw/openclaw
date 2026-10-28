import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256File } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { root, type Root } from "../../infra/fs-safe.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { shellEscape } from "../../shared/shell-quote.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./local-workspace-projection.js";
import type { projectionOperations } from "./local-workspace-state.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import {
  OVERSIZED_WORKSPACE_TOTAL_ERROR_PREFIX,
  workspaceSizeRecoveryPaths,
} from "./workspace-manifest-comparison.js";
import {
  captureWorkspaceManifestDocument,
  parseWorkspaceManifestPair,
} from "./workspace-manifest-worker.js";
import { manifestPath, MAX_RECONCILIATION_FILE_BYTES } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import { hasWorkerWorkspaceResultRef } from "./workspace-result-staging.js";

type RecoveryState = Pick<
  ReturnType<typeof projectionOperations>,
  "current" | "canonicalPaths" | "baselineDocument" | "buildCacheInputs"
>;

function recoveryPath(value: string) {
  const selectedPath = manifestPath(value);
  if (
    selectedPath.split("/").some((part) => part.toLowerCase() === ".git") ||
    isDerivedWorkspacePath(selectedPath, false, true)
  ) {
    throw new Error("Select a retained workspace file and a UUID recovery ID");
  }
  return selectedPath;
}

async function hasAggregateOverflow(state: RecoveryState): Promise<boolean> {
  const baseline = await state.baselineDocument();
  const retained = await state.buildCacheInputs();
  const selected = state.current();
  const current = await captureWorkspaceManifestDocument({
    root: selected.projection_path,
    baseCommit: selected.base_commit,
    buildCacheInputs: new Set(retained),
  });
  state.current();
  try {
    await parseWorkspaceManifestPair({
      baseRaw: baseline.rawManifest,
      baseRef: baseline.manifestRef,
      currentRaw: current.rawManifest,
      currentRef: current.manifestRef,
      buildCacheInputs: retained,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(OVERSIZED_WORKSPACE_TOTAL_ERROR_PREFIX)
    ) {
      return true;
    }
    throw error;
  }
  return false;
}

async function openRecoverableFile(
  owner: LocalWorkspaceOwner,
  state: RecoveryState,
  stateRoot: Root,
  selectedPath: string,
  aggregateOverflow?: boolean,
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
  try {
    if (
      file.stat.size <= MAX_RECONCILIATION_FILE_BYTES &&
      (file.stat.size === 0 || !(aggregateOverflow ?? (await hasAggregateOverflow(state))))
    ) {
      throw new Error(
        "Selected file does not exceed the 64 MiB limit and no aggregate overflow requires recovery",
      );
    }
  } catch (error) {
    await file[Symbol.asyncDispose]();
    throw error;
  }
  return file;
}

/** Advice uses the same eligibility checks as relocation, under the existing workspace lease. */
export async function describeLocalWorkspaceRecovery(
  error: Error,
  owner: LocalWorkspaceOwner,
  state: RecoveryState,
): Promise<Error> {
  const paths = workspaceSizeRecoveryPaths(error);
  for (const candidate of paths) {
    try {
      const selectedPath = recoveryPath(candidate);
      const stateRoot = await root(resolveStateDir(owner.env), {
        symlinks: "reject",
        hardlinks: "reject",
      });
      const file = await openRecoverableFile(
        owner,
        state,
        stateRoot,
        selectedPath,
        error.message.startsWith(OVERSIZED_WORKSPACE_TOTAL_ERROR_PREFIX),
      );
      await file[Symbol.asyncDispose]();
      state.current();
      return new Error(
        error.message +
          "\nPending workspace changes were preserved. Ask a Gateway administrator to run:\n" +
          "openclaw sandbox recover --session " +
          shellEscape(owner.sessionKey) +
          " --path " +
          shellEscape(selectedPath) +
          "\nRun this command in Bash or zsh on the Gateway host, then retry the session. The selected file is preserved outside workspace synchronization. Repeat for another selected file if the remaining payload is still too large.",
        { cause: error },
      );
    } catch {
      // A diagnostic candidate is not relocation authority. Try the next new
      // file without advertising a command for an admitted or unsafe path.
    }
  }
  return error;
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
        try {
          await stateRoot.move(source, destination);
        } catch (error) {
          if (!hasErrnoCode(error, "EXDEV")) {
            throw error;
          }
          await stateRoot.copyIn(
            destination,
            { root: stateRoot, relativePath: source },
            {
              overwrite: false,
              maxBytes: file.stat.size,
              preserveSourceMode: true,
              signal: params.signal,
            },
          );
          await using recovered = await stateRoot.open(destination);
          await recovered.handle.sync();
          const original = await sha256File(file.handle, {
            maxBytes: file.stat.size,
            signal: params.signal,
          });
          const copied = await sha256File(recovered.handle, {
            maxBytes: file.stat.size,
            signal: params.signal,
          });
          if (
            original.bytes !== file.stat.size ||
            copied.bytes !== original.bytes ||
            copied.digest !== original.digest
          ) {
            throw new Error("Recovery copy does not match the retained file", { cause: error });
          }
          // A crash before source removal leaves both names; the existing both-names
          // error surfaces those copies for operator inspection on retry.
          await stateRoot.remove(source);
        }
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
