import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { owesRequesterCompletion } from "../agents/subagents/registry/subagent-requester-settle-identity.js";
import { isYieldedSubagentRun } from "../agents/subagents/registry/subagent-run-liveness.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import type {
  PreparedRestartStore,
  RestartResumeParams,
} from "./session-restart-resume-discovery.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

/** Admit retained obligations before classifying nested waits in this store. */
export async function prepareRestartCompletionCustody(
  { context, signal, log }: RestartResumeParams,
  { target, entries }: Pick<PreparedRestartStore, "target" | "entries">,
): Promise<{ assertCurrent: () => void; resume: () => void }> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  assertCurrent();
  const recovered: string[] = [];
  for (const { sessionKey, entry } of entries) {
    try {
      recovered.push(
        ...(await recoverRequesterCompletionCustody({
          context,
          ...target,
          sessionKey,
          entry,
          agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
          assertCurrent,
        })),
      );
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
    }
  }
  return {
    assertCurrent,
    resume: () => {
      signal.throwIfAborted();
      if (!isGatewayRestartDraining()) {
        for (const runId of recovered) {
          resumeSubagentRun(runId);
        }
      }
    },
  };
}

/** Recover the obligation under a fresh exact requester admission, never its stored bearer. */
async function recoverRequesterCompletionCustody(params: {
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt">;
  assertCurrent: () => void;
}): Promise<string[]> {
  const { context, entry, agentId, sessionKey, storePath, assertCurrent } = params;
  if (entry.archivedAt !== undefined) {
    return [];
  }
  const pending = [...getSubagentRunsForRequesterSession(sessionKey)].filter(
    (child) =>
      child.requesterAgentId === agentId &&
      child.completionRequesterSessionId === entry.sessionId &&
      child.completionRequesterLifecycleRevision === entry.lifecycleRevision &&
      subagentRuns.isCompletionAuthorityRetired(child) &&
      ((isYieldedSubagentRun(child) && owesRequesterCompletion(child)) ||
        child.requesterSettleWake !== undefined ||
        child.delivery?.status === "pending" ||
        child.delivery?.status === "in_progress" ||
        child.delivery?.status === "failed"),
  );
  if (!pending.length) {
    return [];
  }
  const authority = await prepareSessionSystemTurnAuthority({
    context,
    agentId,
    sessionKey,
    storePath,
    sessionId: entry.sessionId,
    preserveRecordedSource: true,
    assertCurrent,
  });
  let target: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  try {
    target = await prepareSessionGenerationFacts({
      agentId,
      sessionKey,
      storePath,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision ?? null,
      env: params.env,
    });
    const requester = target;
    await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
      withOperatorToolGatewayAuthority(
        {
          operatorRunAuthority: authority?.authority,
          operatorRoleActor: { kind: "system" },
          scopes: authority?.authority.scopes ?? [ADMIN_SCOPE],
          assertCurrent,
        },
        async () => {
          for (const child of pending) {
            const custody = await captureOperatorToolGatewayContinuationContext({
              agentId,
              sessionKey,
            });
            if (!custody) {
              throw new Error("Restart completion has no current Gateway authority");
            }
            try {
              assertCurrent();
              requester.assertCurrent();
              bindGatewayContextResolver(child, context.resolveGatewayContext);
              subagentRuns.bindCompletionAuthority(child, custody);
            } catch (error) {
              custody.release();
              throw error;
            }
          }
        },
      ),
    );
  } finally {
    target?.release();
    authority?.release();
  }
  return pending.map((child) => child.runId);
}
