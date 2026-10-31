import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { prepareProjectedSessionSharing, isGatewayAdmin } from "./session-sharing.js";

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
    if (
      !client?.connect ||
      (client.connect.role ?? "operator") !== "operator" ||
      !operatorScopeSatisfied(READ_SCOPE, client.connect.scopes ?? [])
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
    const audience = currentRevision && !hasMemoryWatches ? sharing.getCacheKey() : undefined;
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
    if (audience !== undefined) {
      audiences.set(audience, view);
    }
    return view;
  };
}
