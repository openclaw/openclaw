import type { SessionRowReadView } from "../../gateway/session-row-prepared-read.js";
import type { AgentToAgentPolicy } from "../../plugin-sdk/session-visibility.js";
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

/** Keep an admitted disclosure bound to the same live transcript identities at publication. */
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
  const requester = read.describe({
    agentId: params.requesterAgentId,
    key: params.requesterSessionKey,
  });
  return params.targets.map((target) => {
    if (isSelf(target)) {
      return requester !== undefined;
    }
    const current = read.describe(target);
    if (
      !requester ||
      !current ||
      (!params.allowArchivedMetadata && current.entry.archivedAt !== undefined) ||
      (target.expectedSessionId && current.entry.sessionId !== target.expectedSessionId)
    ) {
      return false;
    }
    return true;
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
