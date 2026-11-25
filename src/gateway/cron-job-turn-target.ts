import { isDeepStrictEqual } from "node:util";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { resolveScheduledRequester } from "../cron/execution-context.js";
import type { CronStoredJob } from "../cron/types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { hasAutomationAdminDelegation } from "./operator-run-recovery-source.codec.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

/** Capture the requester's reference; the event admits it when its work starts. */
export async function captureCronJobTurnTarget(params: {
  job: CronStoredJob;
  agentId: string;
  sessionKey: string;
  context: GatewayRequestContext;
}): Promise<SessionEventTarget> {
  const { job, agentId, sessionKey, context } = params;
  const capture = async (options?: Parameters<typeof captureSessionEventTargetForHost>[2]) => {
    const target = await captureSessionEventTargetForHost(agentId, sessionKey, options);
    bindGatewayContextResolver(target, context.resolveGatewayContext ?? (() => context));
    return target;
  };
  const requester = resolveScheduledRequester(job);
  if (requester.kind === "unknown") {
    return await capture();
  }
  if (requester.kind !== "operator-source") {
    const assertCurrent = () => {
      const current = context.cron.getJob(job.id);
      if (!current || !isDeepStrictEqual(resolveScheduledRequester(current), requester)) {
        throw new Error("Automation requester changed.");
      }
    };
    return await capture({ scheduledRequester: requester, assertCurrent });
  }
  const { source } = requester;
  if (
    source.agentId !== agentId ||
    (source.kind !== "gateway" && source.sessionKey !== sessionKey)
  ) {
    throw new Error("Automation operator source names another conversation");
  }
  const captured = job.operatorSource;
  return await capture({
    operatorSource: source,
    ...(hasAutomationAdminDelegation(source.snapshot) &&
    operatorScopeSatisfied("operator.admin", source.snapshot.scopes)
      ? { ownerContinuation: true as const }
      : {}),
    assertCurrent: () => {
      if (!isDeepStrictEqual(context.cron.getJob(job.id)?.operatorSource, captured)) {
        throw new Error("Automation operator source changed");
      }
    },
  });
}
