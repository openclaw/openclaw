// Continuation (karmaterminal): the Gateway reset's hooks for its retention of the session's
// continuation-elected delegate tree (../auto-reply/continuation/session-reset-retention.ts).
import { prepareContinuationResetRetention } from "../auto-reply/continuation/session-reset-retention.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureSessionRuntimeCleanup } from "./session-reset-runtime-cleanup.js";

export function prepareGatewayResetRetention(resetTarget: {
  cfg: OpenClawConfig;
  storePath: string;
  target: { canonicalKey: string; agentId: string };
}) {
  const retention = prepareContinuationResetRetention({
    cfg: resetTarget.cfg,
    sessionKey: resetTarget.target.canonicalKey,
    agentId: resetTarget.target.agentId,
    storePath: resetTarget.storePath,
  });
  return {
    successorRevision: retention.successorRevision,
    stopSubagents: retention.stopResetSubagents,
    /**
     * The second reset kill, for the session generation under reset, honors the marks the
     * preemption's kill wrote. An incognito reset deletes the row, so it ends the session's
     * continuation custody as a delete does.
     */
    runtimeCleanup: ({
      entry,
      ...params
    }: Omit<
      Parameters<typeof ensureSessionRuntimeCleanup>[0],
      "sessionId" | "sessionLifecycleRevision"
    > & { entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined }) =>
      retention.runKill(() =>
        ensureSessionRuntimeCleanup({
          ...params,
          sessionId: entry?.sessionId,
          sessionLifecycleRevision: entry?.lifecycleRevision,
        }),
      ),
    /** Settles the marks after the mutation's own finalize, still inside the lifecycle mutation. */
    finalizing: (finalize: () => Promise<void>) => async () => {
      try {
        await finalize();
      } finally {
        await retention.resolve();
      }
    },
  };
}
