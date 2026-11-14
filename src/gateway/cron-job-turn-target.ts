import { isDeepStrictEqual } from "node:util";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { checkRequesterOwner } from "../cron/execution-context-admission.js";
import { resolveScheduledRequester } from "../cron/execution-context.js";
import type { CronStoredJob } from "../cron/types.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

/**
 * Captures the owner conversation for a turn the scheduler starts about one job (its failure
 * repair or a notice), acting for the job's recorded requester: the requester its scheduled
 * runs act for. An owner requester keeps owner tools while it stays an owner; a non-owner
 * requester gets none; a job with no recorded requester falls back to the session
 * principal like other unattributed system turns.
 */
export async function captureCronJobTurnTarget(params: {
  job: CronStoredJob;
  agentId: string;
  sessionKey: string;
  context: GatewayRequestContext;
}): Promise<{ target: SessionEventTarget; release: () => void }> {
  const { job, agentId, sessionKey, context } = params;
  const capture = (options?: Parameters<typeof captureSessionEventTargetForHost>[2]) =>
    captureSessionEventTargetForHost(agentId, sessionKey, options);
  const nonOwner = async () => ({
    // A known requester that is not, or no longer, an owner: never the session principal.
    target: await capture({ requesterOwner: {} }),
    release: () => {},
  });
  let requester: ReturnType<typeof resolveScheduledRequester>;
  try {
    requester = resolveScheduledRequester(job);
  } catch {
    // An undecodable stored operator source; its scheduled runs fail the same way.
    return await nonOwner();
  }
  if (requester.kind === "unknown") {
    return { target: await capture(), release: () => {} };
  }
  if (requester.kind !== "operator-source") {
    const { owner, isOwner } = await checkRequesterOwner(context.getRuntimeConfig(), requester);
    // Recheck against the Gateway's current config before each owner-only effect, as
    // completions do for their requester; a revocation while queued is refused.
    const assertCurrent = () => {
      if (!isOwner?.(context.getRuntimeConfig())) {
        throw new Error("The requester that authorized this automation is no longer an owner.");
      }
    };
    const target = await capture({ requesterOwner: owner && isOwner ? { assertCurrent } : {} });
    return { target, release: () => {} };
  }
  // Operator-source jobs are owned by the conversation their source names.
  const { source } = requester;
  const captured = job.operatorSource;
  let operator: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
  try {
    if (source.agentId !== agentId || source.sessionKey !== sessionKey) {
      throw new Error("Automation operator source names another conversation");
    }
    operator = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: { agentId, sessionKey, sessionId: source.sessionId },
      context,
      assertCurrent: () => {
        if (!isDeepStrictEqual(context.cron.getJob(job.id)?.operatorSource, captured)) {
          throw new Error("Automation operator source changed");
        }
      },
    });
    // As for the job's in-session runs, a restored source is an owner only when it was a
    // Control UI administrator; otherwise it is the job's non-owner requester.
    const target = await capture({
      operatorAuthority: operator.authority,
      ...(operator.controlUiAdmin ? { ownerContinuation: true as const } : {}),
    });
    if (target.sessionId !== source.sessionId) {
      throw new Error("Automation owner conversation was reset");
    }
    return { target, release: operator.release };
  } catch {
    operator?.release();
    return await nonOwner();
  }
}
