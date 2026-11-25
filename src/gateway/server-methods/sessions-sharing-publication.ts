import type {
  SessionMemberPermissionLevel,
  SessionSharingEvidenceEvent,
  SessionSharingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { getResidentUserProfileDisplay } from "../../state/user-profile-list.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { SharingActorFacts } from "./sessions-sharing-identities.js";
import type { GatewayRequestContext } from "./types.js";

export function publishSharingChange(params: {
  context: GatewayRequestContext;
  actor: SharingActorFacts;
  event: Omit<SessionSharingEvidenceEvent, "actorState">;
}): void {
  bumpGatewayAccessRevision();
  const eventOptions = {
    sessionKeys: [params.event.sessionKey],
  };
  // Explicit invitation levels belong to admitted human profiles, not opaque channel ids.
  const change = {
    ...params.event,
    ...(params.event.access && params.event.identityId
      ? {
          identityLabel:
            getResidentUserProfileDisplay(params.event.identityId).displayName ?? undefined,
        }
      : {}),
  };
  if (params.actor.state === "present") {
    const event: SessionSharingEvent = { ...change, actor: params.actor.actor };
    params.context.broadcast("session.sharing", event, eventOptions);
  } else {
    const event: SessionSharingEvidenceEvent = {
      ...change,
      ...(params.actor.state === "unknown" ? { actorState: "unknown" } : {}),
    };
    params.context.broadcast("session.sharing.evidence", event, eventOptions);
  }
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.event.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}

/** Broadcast the acknowledged reduction after the storage owner has retired its producers. */
export function publishSessionMemberAccessReduced(params: {
  context: GatewayRequestContext;
  actor: SharingActorFacts;
  target: SessionSharingTarget;
  identityId: string;
  access?: SessionMemberPermissionLevel;
  ts: number;
}): void {
  publishSharingChange({
    context: params.context,
    actor: params.actor,
    event: {
      action: params.access ? "member-access-changed" : "member-removed",
      sessionKey: params.target.canonicalKey,
      agentId: params.target.agentId,
      identityId: params.identityId,
      ...(params.access ? { access: params.access } : {}),
      ts: params.ts,
    },
  });
}
