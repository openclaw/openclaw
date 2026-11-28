import type { WorktreesSessionOwnersResult } from "../../../packages/gateway-protocol/src/schema/worktrees.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  toProjectedSessionSharingTarget,
  withReadySessionRows,
} from "../session-row-prepared-read.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function readWorktreeSessionOwners(
  context: GatewayRequestHandlerOptions["context"],
  client: GatewayRequestHandlerOptions["client"],
  keys: string[],
  respond: (result: WorktreesSessionOwnersResult) => void,
) {
  const projection = requireSessionRowProjection(context);
  const requestedKeys = [...new Set(keys)].filter((key) => !isIncognitoSessionKey(key));
  const select = (cfg: OpenClawConfig) =>
    requestedKeys.flatMap((key) => {
      const agent = resolveRequestedSessionAgentId(cfg, key, undefined, "read");
      return agent.ok ? [{ key, agentId: agent.agentId }] : [];
    });
  await withReadySessionRows(projection, select, (read) => {
    const sharing = prepareProjectedSessionSharing({
      cfg: read.state.policyConfig,
      client: client ?? null,
      isMember: (target, identity) =>
        read.hasMembership(target.storePath, target.storeKey, identity, target.agentId),
    });
    const sessions = select(read.state.cfg).flatMap((query) => {
      const record = read.describe(query);
      if (
        !record ||
        record.entry.incognito ||
        !sharing.canReadTarget(toProjectedSessionSharingTarget(record))
      ) {
        return [];
      }
      const { key, label, displayName, boardFace } = record.materialized.row;
      return [
        { requestedKey: query.key, key, agentId: record.agentId, label, displayName, boardFace },
      ];
    });
    respond({ sessions });
  });
}
