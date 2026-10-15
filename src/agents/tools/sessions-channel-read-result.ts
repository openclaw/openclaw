import type { SessionRowReadView } from "../../gateway/session-row-prepared-read.js";
import {
  createSessionVisibilityDecisionChecker,
  resolveSessionChannelScope,
} from "../../plugin-sdk/session-visibility-internal.js";
import type { AgentToAgentPolicy } from "../../plugin-sdk/session-visibility.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

export type SessionChannelReadTarget = {
  key: string;
  agentId: string;
  expectedSessionId?: string;
  storePath?: string;
};

type ChannelReadParams = {
  requesterAgentId: string;
  requesterSessionKey: string;
  a2aPolicy: AgentToAgentPolicy;
  targets: readonly SessionChannelReadTarget[];
  /** Explicit archive inventory may disclose metadata, never transcript enrichment. */
  allowArchivedMetadata?: boolean;
};

/** Check every buffered disclosure in the same synchronous owner read as its publication. */
export function currentSessionChannelReadAccess(
  params: ChannelReadParams,
  read?: SessionRowReadView,
): boolean[] {
  const isSelf = (target: SessionChannelReadTarget) =>
    target.agentId === params.requesterAgentId && target.key === params.requesterSessionKey;
  if (!read) {
    if (params.targets.some((target) => !isSelf(target))) {
      throw new Error(
        "Cross-session channel retrieval requires the local Gateway read owner; retry from a Gateway-hosted agent.",
      );
    }
    return params.targets.map(() => true);
  }
  const scope = (target: Pick<SessionChannelReadTarget, "key" | "agentId" | "storePath">) => {
    const row = read.describe(target);
    return (
      row && {
        row,
        channelScope: resolveSessionChannelScope({
          key: row.key,
          chatType: row.entry.chatType,
          space: row.entry.space,
          origin: sessionDeliveryOrigin(row.entry),
          deliveryContext: deliveryContextFromSession(row.entry),
        }),
      }
    );
  };
  const requester = scope({
    agentId: params.requesterAgentId,
    key: params.requesterSessionKey,
  });
  const checker = createSessionVisibilityDecisionChecker({
    action: "history",
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannelScope: requester?.channelScope,
    visibility: "channel",
    a2aPolicy: params.a2aPolicy,
  });
  return params.targets.map((target) => {
    if (isSelf(target)) {
      return true;
    }
    const current = scope(target);
    return Boolean(
      current &&
      (params.allowArchivedMetadata || current.row.entry.archivedAt === undefined) &&
      (!target.expectedSessionId || current.row.entry.sessionId === target.expectedSessionId) &&
      checker.check({ ...target, channelScope: current.channelScope }).allowed,
    );
  });
}

export async function withCurrentSessionChannelReadAccess<T>(
  params: ChannelReadParams,
  consume: (visible: readonly boolean[]) => T,
): Promise<T> {
  const context = getInProcessGatewayToolContext();
  const { getSessionRowProjection } =
    await import("../../gateway/session-row-projection-access.js");
  const projection = getSessionRowProjection(context);
  if (!projection) {
    return consume(currentSessionChannelReadAccess(params));
  }
  const { withReadySessionRows } = await import("../../gateway/session-row-prepared-read.js");
  return withReadySessionRows(
    projection,
    () => [
      { key: params.requesterSessionKey, agentId: params.requesterAgentId },
      ...params.targets,
    ],
    (read) => {
      if (getSessionRowProjection(getInProcessGatewayToolContext()) !== projection) {
        throw new Error("Gateway changed while preparing channel retrieval; retry the request");
      }
      return consume(currentSessionChannelReadAccess(params, read));
    },
  );
}
