import { readCommittedIncognitoSessionSharing } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { authorizeOperatorScopesForRequiredScope, READ_SCOPE } from "./method-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { isGatewayAdmin, prepareProjectedSessionSharing } from "./session-sharing.js";

/** Roster objects are immutable for one publication; authority is checked for every recipient. */
export function createPresenceRecipientProjection(params: {
  cfg: OpenClawConfig;
  presence: SystemPresence[];
  projection?: SessionRowProjection;
}): (client: GatewayClient | null) => SystemPresence[] {
  const keys = [...new Set(params.presence.flatMap((row) => row.watchedSessions ?? []))];
  const views = new Map<string, SystemPresence[]>();
  let routingConfig: OpenClawConfig | undefined;
  let watches: Array<{ sessionKey: string; key: string; agentId?: string }> = [];
  let revision: object | undefined;
  const targets = new Map<string, ReturnType<SessionRowProjection["sharingTarget"]>>();
  const resolveTarget = (sessionKey: string, key: string, agentId: string) => {
    if (isIncognitoSessionKey(key)) {
      const database = getOpenIncognitoAgentDatabase(
        agentId,
        resolveIncognitoOpenClawAgentSqlitePath({ agentId }),
      );
      const entry = database && readCommittedIncognitoSessionSharing(database.db, key)?.entry;
      return entry ? { canonicalKey: key, entry } : undefined;
    }
    if (!targets.has(sessionKey)) {
      targets.set(sessionKey, params.projection?.sharingTarget({ key, agentId }) ?? null);
    }
    return targets.get(sessionKey);
  };
  return (client) => {
    if (
      !client?.connect ||
      (client.connect.role ?? "operator") !== "operator" ||
      !authorizeOperatorScopesForRequiredScope(READ_SCOPE, client.connect.scopes ?? []).allowed
    ) {
      return [];
    }
    const cfg = params.projection?.getPolicyConfig() ?? params.cfg;
    if (routingConfig !== cfg) {
      routingConfig = cfg;
      watches = keys.map((sessionKey) => {
        const parsed = parseAgentSessionKey(sessionKey);
        const key =
          parsed?.rest === "global" || parsed?.rest === "unknown" ? parsed.rest : sessionKey;
        return {
          sessionKey,
          key,
          agentId: resolveSessionEventAgentScope(cfg, key, parsed?.agentId)?.[1],
        };
      });
      targets.clear();
    }
    const currentRevision = params.projection?.sharingRevision;
    if (revision !== currentRevision || currentRevision === undefined) {
      revision = currentRevision;
      targets.clear();
    }
    const canReadSessions = isGatewayAdmin(client) || !isGatewayClientProfilePending(client);
    const { entryFilter } = prepareProjectedSessionSharing({
      cfg,
      client,
      isMember: () => false,
    });
    const visible = new Set<string>();
    const indexes: number[] = [];
    if (canReadSessions) {
      for (const [index, { sessionKey, key, agentId }] of watches.entries()) {
        if (!agentId) {
          continue;
        }
        const target = resolveTarget(sessionKey, key, agentId);
        if (target && (entryFilter?.(target.canonicalKey, target.entry) ?? true)) {
          visible.add(sessionKey);
          indexes.push(index);
        }
      }
    }
    const signature = indexes.join(",");
    let view = views.get(signature);
    if (!view) {
      view = params.presence.map((row) => {
        if (!row.watchedSessions) {
          return row;
        }
        const watchedSessions = row.watchedSessions.filter((key) => visible.has(key));
        const { watchedSessions: _watchedSessions, ...person } = row;
        return watchedSessions.length ? { ...person, watchedSessions } : person;
      });
      views.set(signature, view);
    }
    return view;
  };
}
