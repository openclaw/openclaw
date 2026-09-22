import {
  canManageSessionSharing,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

// Manager authorization runs before the lifecycle fence, so a session can be
// reset or recreated under the same key while a mutation waits. Requiring the
// same session instance and a still-valid manager role inside the fence keeps
// a stale owner from mutating the replacement session's sharing state.
export function requireCurrentManagedTarget(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  authorized: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  operation?: "read" | "mutation";
}): NonNullable<ReturnType<typeof resolveSessionSharingTarget>> {
  const current = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.authorized.canonicalKey,
    agentId: params.authorized.agentId,
  });
  if (
    !current ||
    current.agentId !== params.authorized.agentId ||
    current.canonicalKey !== params.authorized.canonicalKey ||
    current.storeKey !== params.authorized.storeKey ||
    current.storePath !== params.authorized.storePath ||
    current.entry.sessionId !== params.authorized.entry.sessionId
  ) {
    throw new Error(`session changed before sharing ${params.operation ?? "mutation"}`);
  }
  const role = resolveSessionSharingRole({
    client: params.client,
    cfg: params.cfg,
    target: current,
  });
  if (!canManageSessionSharing(role)) {
    throw new Error(`session ownership changed before sharing ${params.operation ?? "mutation"}`);
  }
  return current;
}

export function sharingExpectedEntry(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
) {
  return {
    sessionId: target.entry.sessionId,
    createdActor: target.entry.createdActor,
    visibility: target.entry.visibility,
    incognito: target.entry.incognito,
  };
}

export function assertCurrentSharingManager(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
}): void {
  // The worker compares these entry facts with SQLite inside its transaction.
  // This admission check owns only the live client/profile/config authority.
  if (
    !canManageSessionSharing(
      resolveSessionSharingRole({
        cfg: params.context.getRuntimeConfig(),
        client: params.client,
        target: params.target,
        includeMembership: false,
      }),
    )
  ) {
    throw new Error("session ownership changed before sharing mutation");
  }
}
