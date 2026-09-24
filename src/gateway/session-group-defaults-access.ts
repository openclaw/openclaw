import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { isGatewayAdmin } from "./session-sharing.js";
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
  const prepared = prepareProjectedSessionPresentation(projection, params.client);
  const allowed = new Set(records.map((record) => record.name));
  for (const [name, targetRefs] of projection.sessionGroupTargets()) {
    if (!allowed.has(name)) {
      continue;
    }
    for (const ref of targetRefs) {
      const agentId = resolveSessionStoreAgentId(projection.state.cfg, ref.sessionKey, ref.agentId);
      const target = prepared.target({ agentId, key: ref.sessionKey });
      if (!target || prepared.sharing.authorizeTarget(target)) {
        allowed.delete(name);
        break;
      }
    }
  }
  return records.filter((record) => allowed.has(record.name));
}
