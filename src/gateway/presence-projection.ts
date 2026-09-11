import { expectDefined } from "@openclaw/normalization-core";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { authorizeOperatorScopesForRequiredScope, READ_SCOPE } from "./method-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isGatewayAdmin, prepareSessionSharing } from "./session-sharing.js";
import { prepareGatewaySessionStoreTargetsReadOnly } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionStoreMatchFromStoreKeys } from "./session-utils-store.js";

type PresenceTarget = { canonicalKey: string; entry: SessionEntry } | undefined;

/** One synchronous snapshot/fanout owns these reads; never reuse them across broadcasts. */
export function createPresenceRecipientProjection(params: {
  cfg: OpenClawConfig;
  presence: SystemPresence[];
}): (client: GatewayClient | null) => SystemPresence[] {
  let targets: Map<string, Result<PresenceTarget, unknown>> | undefined;
  const prepareTargets = () => {
    const keys = [...new Set(params.presence.flatMap((row) => row.watchedSessions ?? []))];
    const prepared = prepareGatewaySessionStoreTargetsReadOnly({
      cfg: params.cfg,
      projection: "full",
      targets: keys.map((sessionKey) => {
        const parsed = parseAgentSessionKey(sessionKey);
        // Viewer declarations qualify sentinels; their stored keys remain global/unknown.
        return {
          key: parsed?.rest === "global" || parsed?.rest === "unknown" ? parsed.rest : sessionKey,
          agentId: parsed?.agentId,
        };
      }),
    });
    return new Map<string, Result<PresenceTarget, unknown>>(
      keys.map((sessionKey, index) => {
        const result = expectDefined(prepared[index], "prepared presence target");
        if (!result.ok) {
          return [sessionKey, result];
        }
        try {
          const target = result.value;
          const match = resolveCanonicalSessionStoreMatchFromStoreKeys(
            target.store,
            target.storeKeys,
          );
          return [
            sessionKey,
            ok(match ? { canonicalKey: target.canonicalKey, entry: match.entry } : undefined),
          ];
        } catch (error) {
          return [sessionKey, err(error)];
        }
      }),
    );
  };
  const resolveTarget = (sessionKey: string) => {
    // Dormant until an eligible recipient visits a watch; errors retain visitor order.
    const result = expectDefined((targets ??= prepareTargets()).get(sessionKey), "presence target");
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
  return (client) => {
    // Match system-presence RPC access before projecting any rows: even idle
    // people expose timing through ts and roster ordering, not just named fields.
    if (
      !client?.connect ||
      (client.connect.role ?? "operator") !== "operator" ||
      !authorizeOperatorScopesForRequiredScope(READ_SCOPE, client.connect.scopes ?? []).allowed
    ) {
      return [];
    }
    const canReadSessions =
      // Match session reads: an established admin grant does not depend on profile verification.
      isGatewayAdmin(client) || !isGatewayClientProfilePending(client);
    const entryFilter = canReadSessions
      ? prepareSessionSharing({ cfg: params.cfg, client }).entryFilter
      : undefined;
    return params.presence.map((row) => {
      if (!row.watchedSessions) {
        return row;
      }
      const watchedSessions = canReadSessions
        ? row.watchedSessions.filter((key) => {
            const target = resolveTarget(key);
            return target && (entryFilter?.(target.canonicalKey, target.entry) ?? true);
          })
        : [];
      const { watchedSessions: _watchedSessions, ...person } = row;
      return watchedSessions.length ? { ...person, watchedSessions } : person;
    });
  };
}
