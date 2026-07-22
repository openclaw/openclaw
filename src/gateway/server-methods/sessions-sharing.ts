import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionMemberAddParams,
  validateSessionMemberRemoveParams,
  validateSessionMembersListParams,
  validateSessionVisibilitySetParams,
  type SessionSharingEvent,
  type SessionSharingIdentity,
  type SessionVisibility,
} from "../../../packages/gateway-protocol/src/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  addSessionMember,
  listSessionMembers,
  loadCombinedSessionStoreForGateway,
  removeSessionMember,
} from "../../config/sessions.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  allowedSessionVisibilities,
  canManageSessionSharing,
  invalidateSessionSharingSnapshot,
  isSessionVisibilityAllowed,
  resolveGatewayConnectionIdentity,
  resolveSessionCreator,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const sharingMutationQueues = new Map<string, StoreWriterQueue>();

function runExclusiveSharingMutation<T>(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  run: () => Promise<T>,
): Promise<T> {
  return runQueuedStoreWrite({
    queues: sharingMutationQueues,
    storePath: `${target.storePath}\0${target.canonicalKey}`,
    label: "session-sharing-mutation",
    fn: run,
  });
}

function actorIdentity(client: GatewayClient | null): SessionSharingIdentity {
  return (
    resolveGatewayConnectionIdentity(client) ??
    (client?.connect.scopes?.includes("operator.admin")
      ? { id: "operator.admin", label: "Administrator" }
      : { id: "local-operator", label: "Local operator" })
  );
}

function requireManageableTarget(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"];
}) {
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!target) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  const role = resolveSessionSharingRole({ client: params.client, target });
  if (!canManageSessionSharing(role)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required", {
        details: { code: "SESSION_SHARING_MANAGER_REQUIRED", sessionKey: target.canonicalKey },
      }),
    );
    return null;
  }
  return { target, role };
}

async function knownSessionIdentities(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  actor: SessionSharingIdentity;
}): Promise<SessionSharingIdentity[]> {
  const identities = new Map<string, SessionSharingIdentity>();
  const remember = (identity: SessionSharingIdentity | null) => {
    if (!identity) {
      return;
    }
    const current = identities.get(identity.id);
    identities.set(identity.id, {
      id: identity.id,
      ...((identity.label ?? current?.label) ? { label: identity.label ?? current?.label } : {}),
    });
  };
  remember(params.actor);
  for (const entry of Object.values(loadCombinedSessionStoreForGateway(params.cfg).store)) {
    remember(resolveSessionCreator(entry));
  }
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    if (!(device.roles ?? (device.role ? [device.role] : [])).includes("operator")) {
      continue;
    }
    const id = normalizeOptionalString(device.deviceId);
    if (!id) {
      continue;
    }
    const label = normalizeOptionalString(device.operatorLabel ?? device.displayName);
    remember({ id, ...(label ? { label } : {}) });
  }
  return [...identities.values()].toSorted(
    (left, right) =>
      (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
      left.id.localeCompare(right.id),
  );
}

async function appendSharingAudit(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  text: string;
  now: number;
}): Promise<void> {
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: params.target.agentId,
    sessionId: params.target.entry.sessionId,
    storePath: params.target.storePath,
  });
  SessionManager.open(sessionFile).appendMessage(
    {
      role: "custom",
      customType: "openclaw.system-note",
      content: `System note: ${params.text}`,
      display: true,
      timestamp: params.now,
    },
    { config: params.cfg },
  );
}

function publishSharingChange(params: {
  context: GatewayRequestContext;
  event: SessionSharingEvent;
  agentId: string;
}): void {
  invalidateSessionSharingSnapshot(params.event.sessionKey);
  params.context.broadcast("session.sharing", params.event, {
    sessionKeys: [params.event.sessionKey],
  });
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.visibility.set": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionVisibilitySetParams,
        "session.visibility.set",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const visibility = params.visibility as SessionVisibility;
    if (!isSessionVisibilityAllowed(cfg, visibility)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session visibility is disabled: ${visibility}`, {
          details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
        }),
      );
      return;
    }
    await runExclusiveSharingMutation(managed.target, async () => {
      const current = resolveSessionSharingTarget({
        cfg,
        sessionKey: managed.target.canonicalKey,
        agentId: managed.target.agentId,
      });
      if (!current) {
        throw new Error("session disappeared before visibility mutation");
      }
      const previous = resolveSessionVisibility(current.entry);
      if (previous === visibility) {
        return;
      }
      const scope = {
        agentId: current.agentId,
        sessionKey: current.canonicalKey,
        storePath: current.storePath,
      };
      await patchSessionEntry(scope, () => ({ visibility }));
      invalidateSessionSharingSnapshot(current.canonicalKey);
      const now = Date.now();
      const actor = actorIdentity(client);
      try {
        await appendSharingAudit({
          cfg,
          target: current,
          text: `${actor.label ?? actor.id} changed session visibility from ${previous} to ${visibility}.`,
          now,
        });
      } catch (error) {
        await patchSessionEntry(scope, (entry) =>
          resolveSessionVisibility(entry) === visibility ? { visibility: previous } : null,
        );
        invalidateSessionSharingSnapshot(current.canonicalKey);
        throw error;
      }
      publishSharingChange({
        context,
        agentId: current.agentId,
        event: {
          action: "visibility",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          actor,
          visibility,
          ts: now,
        },
      });
    });
    respond(true, { ok: true, sessionKey: managed.target.canonicalKey, visibility }, undefined);
  },

  "session.members.list": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateSessionMembersListParams, "session.members.list", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const target = managed.target;
    const actor = actorIdentity(client);
    const members = listSessionMembers({
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    });
    const identities = await knownSessionIdentities({
      cfg,
      actor,
    });
    for (const member of members) {
      if (!identities.some((identity) => identity.id === member.identityId)) {
        identities.push({ id: member.identityId });
      }
    }
    identities.sort(
      (left, right) =>
        (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
        left.id.localeCompare(right.id),
    );
    respond(
      true,
      {
        sessionKey: target.canonicalKey,
        ...(resolveSessionCreator(target.entry)
          ? { owner: resolveSessionCreator(target.entry) }
          : {}),
        members,
        identities,
        role: managed.role,
        allowedVisibilities: allowedSessionVisibilities(cfg),
      },
      undefined,
    );
  },

  "session.members.add": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateSessionMemberAddParams, "session.members.add", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const actor = actorIdentity(client);
    const known = await knownSessionIdentities({
      cfg,
      actor,
    });
    if (!known.some((identity) => identity.id === params.identityId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown identity"));
      return;
    }
    const scope = {
      agentId: managed.target.agentId,
      sessionKey: managed.target.canonicalKey,
      storePath: managed.target.storePath,
    };
    await runExclusiveSharingMutation(managed.target, async () => {
      const now = Date.now();
      const added = addSessionMember(scope, {
        identityId: params.identityId,
        addedBy: actor.id,
        addedAt: now,
      });
      if (!added.inserted) {
        return;
      }
      try {
        await appendSharingAudit({
          cfg,
          target: managed.target,
          text: `${actor.label ?? actor.id} added ${params.identityId} as a session member.`,
          now,
        });
      } catch (error) {
        removeSessionMember(scope, params.identityId, added.member);
        throw error;
      }
      publishSharingChange({
        context,
        agentId: managed.target.agentId,
        event: {
          action: "member-added",
          sessionKey: managed.target.canonicalKey,
          agentId: managed.target.agentId,
          actor,
          identityId: params.identityId,
          ts: now,
        },
      });
    });
    respond(
      true,
      { ok: true, sessionKey: managed.target.canonicalKey, identityId: params.identityId },
      undefined,
    );
  },

  "session.members.remove": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionMemberRemoveParams,
        "session.members.remove",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const scope = {
      agentId: managed.target.agentId,
      sessionKey: managed.target.canonicalKey,
      storePath: managed.target.storePath,
    };
    await runExclusiveSharingMutation(managed.target, async () => {
      const removed = removeSessionMember(scope, params.identityId);
      if (!removed) {
        return;
      }
      const now = Date.now();
      const actor = actorIdentity(client);
      try {
        await appendSharingAudit({
          cfg,
          target: managed.target,
          text: `${actor.label ?? actor.id} removed ${params.identityId} from session members.`,
          now,
        });
      } catch (error) {
        addSessionMember(scope, {
          identityId: removed.identityId,
          addedBy: removed.addedBy,
          addedAt: removed.addedAt,
        });
        throw error;
      }
      publishSharingChange({
        context,
        agentId: managed.target.agentId,
        event: {
          action: "member-removed",
          sessionKey: managed.target.canonicalKey,
          agentId: managed.target.agentId,
          actor,
          identityId: params.identityId,
          ts: now,
        },
      });
    });
    respond(
      true,
      { ok: true, sessionKey: managed.target.canonicalKey, identityId: params.identityId },
      undefined,
    );
  },
};
