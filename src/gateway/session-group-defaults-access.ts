import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { isGatewayAdmin, prepareProjectedSessionSharing } from "./session-sharing.js";
import { resolveSessionStoreAgentId } from "./session-store-key.js";

/** Keep shared group settings visible only where every member session is mutable. */
export async function filterMutableSessionGroupRecords<T extends { name: string }>(params: {
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "sessionRowProjectionOwner">;
  records: () => readonly T[];
}): Promise<T[]> {
  if (params.records().length === 0) {
    return [];
  }
  if (isGatewayAdmin(params.client)) {
    return [...params.records()];
  }
  const projection = getSessionRowProjection(params.context);
  if (!projection) {
    throw new Error("Session group membership is unavailable during Gateway startup");
  }
  do {
    await projection.prepareMembership();
  } while (projection.needsMembershipPreparation());
  const records = params.records();
  const sharing = prepareProjectedSessionSharing({
    cfg: projection.state.policyConfig,
    client: params.client,
    isMember: (target, identityId) =>
      projection.hasMembership(target.storePath, target.storeKey, identityId),
  });
  const allowed = new Set(records.map((record) => record.name));
  for (const [name, targetRefs] of projection.sessionGroupTargets()) {
    if (!allowed.has(name)) {
      continue;
    }
    for (const ref of targetRefs) {
      const agentId = resolveSessionStoreAgentId(projection.state.cfg, ref.sessionKey, ref.agentId);
      const target = projection.sharingTarget({ agentId, key: ref.sessionKey });
      if (!target || sharing.authorizeTarget(target)) {
        allowed.delete(name);
        break;
      }
    }
  }
  return records.filter((record) => allowed.has(record.name));
}
