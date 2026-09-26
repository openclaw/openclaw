import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { hiddenSessionNotFound } from "./session-sharing-policy.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import {
  resolveDirectSessionTargets,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";

export function resolveProjectedSessionSharingTarget(params: {
  sessionRowRead?: SessionRowReadView;
  method: string;
  requestParams: unknown;
  sessionScope: string | undefined;
  targetRef: SessionMutationTarget;
}):
  | { target: SessionSharingTarget | null; preparedReadSource?: SessionSharingTarget["readSource"] }
  | { error: ErrorShape }
  | undefined {
  if (
    !params.sessionRowRead ||
    !resolveDirectSessionTargets(params.method, params.requestParams).some(
      (direct) =>
        direct.sessionKey === params.targetRef.sessionKey &&
        direct.agentId === params.targetRef.agentId,
    )
  ) {
    return undefined;
  }
  const agent = resolveRequestedSessionAgentId(
    params.sessionRowRead.state.cfg,
    params.targetRef.sessionKey,
    params.targetRef.agentId,
  );
  if (!agent.ok) {
    return { error: agent.error };
  }
  const row = params.sessionRowRead.describe({
    key: params.targetRef.sessionKey,
    agentId: agent.agentId,
  });
  if (!row && params.sessionScope === "operator.sessions.read") {
    return { error: hiddenSessionNotFound(params.targetRef.sessionKey) };
  }
  const readSource = row && params.sessionRowRead.readSource(row);
  return {
    preparedReadSource: readSource,
    target: row?.storedEntry
      ? {
          agentId: row.agentId,
          canonicalKey: row.key,
          storeKey: row.key,
          storeKeys: [row.key],
          storePath: row.storeTarget.storePath,
          readSource,
          entry: row.storedEntry,
        }
      : null,
  };
}

export function authorizeSessionDescribe(params: {
  client: GatewayClient | null;
  requestParams: unknown;
  context: GatewayRequestContext;
  sessionRowRead?: SessionRowReadView;
}): ErrorShape | null {
  const projection = params.sessionRowRead ?? getSessionRowProjection(params.context);
  if (!projection) {
    return null;
  }
  const { cfg, policyConfig } = projection.state;
  for (const target of resolveDirectSessionTargets("sessions.describe", params.requestParams)) {
    const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
    if (!agent.ok) {
      return agent.error;
    }
    const row = projection.describe({ key: target.sessionKey, agentId: agent.agentId });
    const sharing = prepareProjectedSessionSharing({
      cfg: policyConfig,
      client: params.client,
      isMember: (_target, identityId) => row?.membership.has(identityId) ?? false,
    });
    if (
      row &&
      gatewayClientSessionCreator(params.client) &&
      sharing.sessionCap === "none" &&
      !sharing.isCreator(row.entry.createdActor)
    ) {
      return hiddenSessionNotFound(target.sessionKey);
    }
  }
  return null;
}
