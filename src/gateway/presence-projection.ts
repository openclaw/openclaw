import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { prepareProjectedSessionSharing, isGatewayAdmin } from "./session-sharing.js";

/**
 * Session-scoped viewers (for example guests) see who is online and active, never
 * device, network, connection, or email details. One row per source row keeps
 * presence delta keys aligned; rows without a resolved profile carry no person.
 */
function projectPersonPresence(row: SystemPresence, visible: ReadonlySet<string>): SystemPresence {
  const user = row.user?.identity
    ? {
        id: row.user.id,
        identity: row.user.identity,
        ...(row.user.name ? { name: row.user.name } : {}),
        ...(row.user.avatarUrl ? { avatarUrl: row.user.avatarUrl } : {}),
      }
    : undefined;
  const watchedSessions = user ? row.watchedSessions?.filter((key) => visible.has(key)) : undefined;
  return {
    ts: row.ts,
    text: "",
    ...(row.reason === "disconnect" ? { reason: row.reason } : {}),
    ...(user && row.lastActivityAt !== undefined ? { lastActivityAt: row.lastActivityAt } : {}),
    ...(user ? { user } : {}),
    ...(watchedSessions?.length ? { watchedSessions } : {}),
  };
}

/** Roster objects are immutable for one publication; authority is checked for every recipient. */
export function createPresenceRecipientProjection(params: {
  cfg: OpenClawConfig;
  presence: SystemPresence[];
  projection?: Pick<
    SessionRowProjection,
    "getPolicyConfig" | "sharingRevision" | "sharingTargetState" | "hasMembership"
  >;
}): (client: GatewayClient | null) => SystemPresence[] {
  const keys = [...new Set(params.presence.flatMap((row) => row.watchedSessions ?? []))];
  const memory = getSessionActorStorageBinding({});
  const memoryOwners = new Map<string, ReturnType<typeof captureSessionActorStorageOwner>>();
  for (const key of keys) {
    if (!isIncognitoSessionKey(key)) {
      continue;
    }
    const agentId = resolveSessionEventAgentScope(
      params.cfg,
      key,
      parseAgentSessionKey(key)?.agentId,
    )?.[1];
    if (agentId && !memoryOwners.has(agentId)) {
      memoryOwners.set(
        agentId,
        captureSessionActorStorageOwner(
          { agentId, sessionKey: key, sessionActor: memory },
          { assertCurrent() {}, authorize() {} },
        ),
      );
    }
  }
  const views = new Map<string, SystemPresence[]>();
  const audiences = new Map<string, SystemPresence[]>();
  const hasMemoryWatches = keys.some(isIncognitoSessionKey);
  let routingConfig: OpenClawConfig | undefined;
  let watches: Array<{ sessionKey: string; key: string; agentId?: string }> = [];
  let revision: object | undefined;
  const targets = new Map<string, ReturnType<SessionRowProjection["sharingTarget"]>>();
  const resolveTarget = (sessionKey: string, key: string, agentId: string) => {
    if (isIncognitoSessionKey(key)) {
      memory?.actor.assertReadable();
      const captured = memoryOwners.get(agentId);
      const entry = captured?.owner?.readSession(key, captured.authority)?.entry;
      return entry ? { canonicalKey: key, entry } : undefined;
    }
    if (!targets.has(sessionKey)) {
      const state = params.projection?.sharingTargetState({ key, agentId });
      targets.set(sessionKey, state?.status === "ready" ? state.target : null);
    }
    return targets.get(sessionKey);
  };
  return (client) => {
    if (!client?.connect || (client.connect.role ?? "operator") !== "operator") {
      return [];
    }
    const scopes = client.connect.scopes ?? [];
    const fullDetail = operatorScopeSatisfied(READ_SCOPE, scopes);
    if (!fullDetail && !operatorScopeSatisfied(SESSION_READ_SCOPE, scopes)) {
      return [];
    }
    const detail = fullDetail ? "full" : "person";
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
      audiences.clear();
    }
    const currentRevision = params.projection?.sharingRevision;
    if (revision !== currentRevision || currentRevision === undefined) {
      revision = currentRevision;
      targets.clear();
      audiences.clear();
    }
    const canReadSessions = isGatewayAdmin(client) || !isGatewayClientProfilePending(client);
    const sharing = prepareProjectedSessionSharing({
      cfg,
      client,
      isMember: (target, identityId) =>
        params.projection?.hasMembership(target.storePath, target.storeKey, identityId) ?? false,
    });
    // Memory actors have independent lifetimes; their watches must stay live.
    const audience =
      currentRevision && !hasMemoryWatches ? `${detail}:${sharing.getCacheKey()}` : undefined;
    const cached = audience === undefined ? undefined : audiences.get(audience);
    if (cached) {
      return cached;
    }
    const visible = new Set<string>();
    const indexes: number[] = [];
    if (canReadSessions) {
      for (const [index, { sessionKey, key, agentId }] of watches.entries()) {
        if (!agentId) {
          continue;
        }
        const target = resolveTarget(sessionKey, key, agentId);
        const canRead =
          target &&
          ("storePath" in target
            ? sharing.canReadTarget(target)
            : (sharing.entryFilter?.(target.canonicalKey, target.entry) ?? true));
        if (canRead) {
          visible.add(sessionKey);
          indexes.push(index);
        }
      }
    }
    const signature = `${detail}:${indexes.join(",")}`;
    let view = views.get(signature);
    if (!view) {
      view = params.presence.map((row) => {
        if (!fullDetail) {
          return projectPersonPresence(row, visible);
        }
        if (!row.watchedSessions) {
          return row;
        }
        const watchedSessions = row.watchedSessions.filter((key) => visible.has(key));
        const { watchedSessions: _watchedSessions, ...person } = row;
        return watchedSessions.length ? { ...person, watchedSessions } : person;
      });
      views.set(signature, view);
    }
    if (audience !== undefined) {
      audiences.set(audience, view);
    }
    return view;
  };
}
