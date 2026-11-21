import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/work-start-error.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { WorktreeRestoreError } from "./errors.js";
import { worktreePathExists, WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";
import { captureWorktreeRegistryReadGuard, readRegistryWorktree } from "./registry-read.js";
import { recordRegistryWorktreeActivity } from "./registry.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";

const log = createSubsystemLogger("agents/worktrees");

class SessionWorktreeUnavailableError extends SessionWorkStartInvalidatedError {
  constructor(
    id: string,
    readonly reason:
      | WorktreeRestoreError["reason"]
      | "restore-required"
      | "restore-failed"
      | "timeout",
    cause?: unknown,
  ) {
    super(
      reason === "no-snapshot" || reason === "restore-required"
        ? `This session's worktree was removed by cleanup or deletion. Use Restore in Settings > Worktrees (worktrees.restore), or start a new session. Worktree: ${id}.`
        : `Automatic worktree restore failed (${reason}). The conversation and saved snapshot are preserved. Check the source repository, available disk space, and any conflicting checkout, then retry or use Restore in Settings > Worktrees (worktrees.restore). Worktree: ${id}.`,
      { cause },
    );
    log.warn("Session worktree unavailable", { worktreeId: id, reason });
  }
}

/** Turns provision their bound checkout; passive review consumes the same lifecycle verdict. */
export async function resolveSessionWorktree(params: {
  binding: NonNullable<SessionEntry["worktree"]>;
  sessionKey: string;
  assertCurrent: () => void;
  restore?: { signal?: AbortSignal; runId?: string };
}) {
  const { binding, sessionKey } = params;
  const context = captureWorktreeRunEndContext(process.env);
  const accept = params.restore
    ? undefined
    : captureWorktreeRegistryReadGuard(context, "lifecycle");
  let worktree = await readRegistryWorktree(context, binding.id);
  const assertOwner = accept?.(worktree);
  const assertCurrent = assertOwner
    ? composeSessionSourceAssertion([params.assertCurrent], (assertSource) => {
        assertSource();
        assertOwner();
      })
    : params.assertCurrent;
  assertCurrent();
  if (!worktree && params.restore) {
    const readiness = captureAgentWorkspaceReadiness(sessionKey);
    if (readiness?.isReady?.() === false) {
      // The admitted creation owns this unpublished checkout and gates workspace effects.
      readiness.assertCurrent();
      return undefined;
    }
  }
  if (
    worktree &&
    (worktree.ownerKind !== "session" ||
      worktree.ownerId !== sessionKey ||
      worktree.repoRoot !== binding.repoRoot ||
      worktree.branch !== binding.branch)
  ) {
    throw new Error("Session worktree owner changed");
  }
  if (!worktree || worktree.removedAt !== undefined || !(await worktreePathExists(worktree.path))) {
    assertCurrent();
    if (!params.restore || !worktree?.snapshotRef) {
      throw new SessionWorktreeUnavailableError(
        binding.id,
        worktree?.snapshotRef ? "restore-required" : "no-snapshot",
      );
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Worktree restore timed out")),
      WORKTREE_CHECKOUT_TIMEOUT_MS,
    );
    timer.unref();
    const signal = params.restore.signal
      ? AbortSignal.any([params.restore.signal, deadline.signal])
      : deadline.signal;
    const started = performance.now();
    if (params.restore.runId) {
      emitAgentRunStatusEvent({
        runId: params.restore.runId,
        sessionKey,
        phase: "preparing_workspace",
      });
    }
    try {
      const { managedWorktrees } = await import("./service.js");
      worktree = await managedWorktrees.restore({
        id: binding.id,
        signal,
        commitGuard: assertCurrent,
        workerAuthority: {
          assertCurrent,
          predicates: [{ kind: "session-owner", id: binding.id, sessionKey }],
        },
      });
      log.info("Session worktree restored", {
        worktreeId: binding.id,
        outcome: "restored",
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      params.restore.signal?.throwIfAborted();
      assertCurrent();
      throw new SessionWorktreeUnavailableError(
        binding.id,
        deadline.signal.aborted
          ? "timeout"
          : error instanceof WorktreeRestoreError
            ? error.reason
            : "restore-failed",
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (params.restore) {
    await recordRegistryWorktreeActivity(context.environment, worktree, assertCurrent);
  }
  return { worktree, assertCurrent, context };
}
