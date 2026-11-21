import { randomUUID } from "node:crypto";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { recoverLocalWorkspaceFile } from "../gateway/worker-environments/local-workspace-recovery.js";
import type { OutputRuntimeEnv } from "../runtime.js";

export async function sandboxRecoverCommand(
  opts: { session: string; path: string; recoveryId?: string; json?: boolean },
  runtime: OutputRuntimeEnv,
) {
  const input = {
    sessionKey: opts.session,
    path: opts.path,
    recoveryId: opts.recoveryId ?? randomUUID(),
  };
  // Print before admission so a lost response still leaves an inspectable recovery ID.
  if (!opts.json) {
    runtime.log("Recovery ID: " + input.recoveryId);
  }
  const result = await runWithLocalStateOwner({
    method: "worktrees.recoverFile",
    params: input,
    target: opts.session,
    recoveryCommand:
      "Inspect workspace-recovery in the selected state directory before retrying with --recovery-id " +
      input.recoveryId,
    runLocal: ({ config, env, signal, assertCurrent }) =>
      recoverLocalWorkspaceFile({
        ...input,
        cfg: config,
        env,
        signal,
        assertCurrent,
      }),
  });
  if (opts.json) {
    runtime.writeJson({ ...result, recoveryId: input.recoveryId });
  } else {
    runtime.log(
      "Preserved " +
        result.bytes +
        " bytes at " +
        result.path +
        ". Retry the session to settle its remaining edits.",
    );
  }
}
