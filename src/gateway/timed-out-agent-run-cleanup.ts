// Force-clears a timed-out isolated agent run so an abort-ignoring turn cannot
// keep its embedded session, lane slot, and MCP runtime alive until restart.
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { abortAndDrainEmbeddedAgentRun } from "../agents/embedded-agent.js";
import type { CronAgentExecutionStarted } from "../cron/types.js";

// Stuck cleanup must not wedge the caller's timeout path; the drain's own
// settleMs bounds the abort wait, this bounds everything else (MCP retire).
const CLEANUP_SETTLE_GUARD_MS = 20_000;

async function drainAndRetireTimedOutRun(params: {
  execution: CronAgentExecutionStarted & { sessionId: string };
  reason: string;
  retireReason: string;
  warn: (meta: Record<string, unknown>, message: string) => void;
}): Promise<void> {
  const { execution } = params;
  try {
    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: execution.sessionId,
      sessionKey: execution.sessionKey,
      settleMs: 15_000,
      forceClear: true,
      reason: params.reason,
    });
    params.warn(
      {
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
        aborted: result.aborted,
        drained: result.drained,
        forceCleared: result.forceCleared,
      },
      "cleaned up timed-out agent run",
    );
  } catch (err) {
    params.warn(
      { sessionId: execution.sessionId, error: String(err) },
      "timed-out agent run cleanup failed",
    );
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: execution.sessionId,
    reason: params.retireReason,
    onError: (error, sid) => {
      params.warn(
        { sessionId: sid },
        `failed to retire MCP runtime for timed-out session: ${String(error)}`,
      );
    },
  }).catch(() => {});
}

export async function cleanupTimedOutIsolatedAgentRun(params: {
  execution: CronAgentExecutionStarted | undefined;
  reason: string;
  retireReason: string;
  warn: (meta: Record<string, unknown>, message: string) => void;
}): Promise<void> {
  const { execution } = params;
  if (!execution?.sessionId) {
    return;
  }
  let settleTimer: NodeJS.Timeout | undefined;
  const settleGuard = new Promise<void>((resolve) => {
    settleTimer = setTimeout(resolve, CLEANUP_SETTLE_GUARD_MS);
    settleTimer.unref?.();
  });
  try {
    await Promise.race([
      drainAndRetireTimedOutRun({
        ...params,
        execution: { ...execution, sessionId: execution.sessionId },
      }),
      settleGuard,
    ]);
  } finally {
    if (settleTimer) {
      clearTimeout(settleTimer);
    }
  }
}
