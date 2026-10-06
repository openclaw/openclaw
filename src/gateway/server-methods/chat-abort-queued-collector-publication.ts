import type { KillPublicationPreparation } from "../../agents/subagents/registry/subagent-control-kill-scope.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type SubagentAdminKillResult,
} from "../../agents/subagents/registry/subagent-control.types.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export function getQueuedCollectorCancellationRunId(
  result: SubagentAdminKillResult,
): string | undefined {
  return result.found &&
    result.killed &&
    result.targetState?.state === "terminal" &&
    result.targetState.task.status === "cancelled" &&
    result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
    ? result.runId
    : undefined;
}

/** Retains the initial session incarnation while the kill owner prepares each notice. */
export function createQueuedCollectorPublication(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  defaultAgentId?: string;
  projection?: SessionRowProjection;
  canPublish: () => boolean;
}): KillPublicationPreparation<SubagentAdminKillResult> & {
  publishSnapshot: (result: SubagentAdminKillResult, settled?: boolean) => void;
} {
  const { projection } = params;
  const agentId = resolveChatRunOwnerAgentId({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    defaultAgentId: params.defaultAgentId,
  });
  const captured = agentId ? projection?.capture({ agentId, key: params.sessionKey }) : undefined;
  let publicationRows: SessionRowReadView | undefined;
  let publishedLastRunId: string | undefined;
  return {
    publishSnapshot: (result, settled = false) => {
      if (!params.canPublish()) {
        return;
      }
      const runId = getQueuedCollectorCancellationRunId(result);
      if (runId === undefined) {
        return;
      }
      const row = agentId
        ? publicationRows?.describe({ agentId, key: params.sessionKey }, captured)
        : undefined;
      const lastRunId = row ? publicationRows?.present(row).lastRunId : undefined;
      if (settled && projection && (lastRunId !== runId || publishedLastRunId === runId)) {
        return;
      }
      // Publish Stop before cleanup, then its qualified identity under the same incarnation.
      emitSessionsChanged(
        params.context,
        {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          sessionId: params.sessionId,
          reason: "abort",
        },
        { preparedPublication: true, sessionRows: publicationRows },
      );
      publishedLastRunId = lastRunId;
    },
    prepare: (publish) =>
      publish(async (publishResult) => {
        const publishPrepared = (read?: SessionRowReadView) => {
          if (captured && !projection?.isCurrent(captured)) {
            throw new Error(
              "Queued collector session changed before cancellation publication; retry Stop.",
            );
          }
          publicationRows = read;
          try {
            return publishResult();
          } finally {
            publicationRows = undefined;
          }
        };
        if (projection && agentId) {
          return await withReadySessionRows(
            projection,
            () => [{ agentId, key: params.sessionKey }],
            publishPrepared,
            { includeAncestors: true },
          );
        }
        return publishPrepared();
      }),
  };
}
