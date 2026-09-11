// Gateway methods for live local sessions: source discovery, enrollment of a
// paired device under the signed-in profile, revocation, and per-thread unshare.
import {
  ErrorCodes,
  errorShape,
  type SessionsLocalEnrollParams,
  type SessionsLocalRevokeParams,
  type SessionsLocalUnshareParams,
  validateSessionsLocalEnrollParams,
  validateSessionsLocalEnrollmentsParams,
  validateSessionsLocalRevokeParams,
  validateSessionsLocalSourcesParams,
  validateSessionsLocalConnectCodeParams,
  validateSessionsLocalUnshareParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import { listSessionEntriesCore } from "../../config/sessions/session-accessor.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import { resolveHostAccountName } from "../../infra/host-account-name.js";
import {
  createLocalSessionConnectIntent,
  createLocalSessionEnrollment,
  listLocalSessionEnrollments,
  readLocalSessionEnrollment,
  transitionLocalSessionEnrollment,
  type LocalSessionEnrollment,
} from "../../state/local-session-enrollments.js";
import { ensureGatewayOwnerProfile, getUserProfileDisplay } from "../../state/user-profiles.js";
import {
  getLocalSessionBridge,
  listRegisteredLocalSessionSources,
} from "../local-sessions/bridge.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { isGatewayAdmin } from "../session-sharing-policy.js";
import { loadSessionEntry } from "../session-utils.js";
import { mintNodeJoinUrl } from "./device-pair-setup.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

async function requireProfile(
  client: GatewayRequestHandlerOptions["client"],
  context: GatewayRequestHandlerOptions["context"],
  respond: GatewayRequestHandlerOptions["respond"],
): Promise<{ profileId: string; displayName: string } | undefined> {
  const profile = client?.authenticatedUserProfile;
  if (profile?.profileId) {
    return { profileId: profile.profileId, displayName: profile.displayName?.trim() || "Teammate" };
  }
  // Shared-secret Gateways without roles have exactly one durable identity, the
  // owner profile; a write-scoped connection there is that owner (docs: teams).
  const scopes = client?.connect?.scopes ?? [];
  const rolesConfigured = Boolean(context.getRuntimeConfig?.()?.gateway?.roles);
  if (!rolesConfigured && !client?.internal?.syntheticClient && scopes.includes("operator.write")) {
    const owner = ensureGatewayOwnerProfile(await resolveHostAccountName());
    const display = getUserProfileDisplay(owner.id);
    return { profileId: display.id, displayName: display.displayName?.trim() || "Owner" };
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.FORBIDDEN,
      "Sharing local sessions needs a signed-in personal profile; on a Gateway with roles, sign in through the Control UI.",
    ),
  );
  return undefined;
}

function publishEnrollment(
  context: GatewayRequestHandlerOptions["context"],
  enrollment: LocalSessionEnrollment,
): void {
  context.broadcast("sessions.local.enrollment", { enrollment });
  getLocalSessionBridge()?.onEnrollmentChanged(enrollment);
}

// Stopping a share ends what teammates can read, not only future records: the
// projected rows leave the Gateway, transcript included. The laptop keeps the
// original, and the exclusion or revoked enrollment keeps the device from
// projecting the thread again.
async function removeProjectedSessions(
  options: GatewayRequestHandlerOptions,
  sessionKeys: string[],
): Promise<string[]> {
  const deleteSession = sessionDeleteHandlers["sessions.delete"];
  const failed: string[] = [];
  for (const sessionKey of sessionKeys) {
    let deleted = false;
    // Local session keys name their agent; sessions.delete resolves the store from the key.
    await deleteSession?.({
      ...options,
      params: { key: sessionKey, deleteTranscript: true, emitLifecycleHooks: false },
      respond: (ok) => {
        deleted = ok;
      },
    });
    if (!deleted) {
      failed.push(sessionKey);
    }
  }
  return failed;
}

// Rows are keyed by owner, device, source, and thread; the enrollment id on a
// row lags behind a same-owner re-share until the device republishes it, so a
// stop is scoped by the identity the row belongs to, not the id it last saw.
function listProjectedSessionKeys(share: {
  agentId: string;
  deviceId: string;
  sourceId: string;
  ownerProfileId: string;
}): string[] {
  return listSessionEntriesCore({ agentId: share.agentId })
    .filter(
      ({ entry }) =>
        entry.localSource?.deviceId === share.deviceId &&
        entry.localSource.sourceId === share.sourceId &&
        sessionCreatorProfileId(entry.createdActor) === share.ownerProfileId,
    )
    .map(({ sessionKey }) => sessionKey);
}

function projectionsNotRemovedError(failed: string[]) {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Sharing stopped, but ${failed.length} mirrored session(s) could not be removed from the Gateway; delete them from the sidebar: ${failed.join(", ")}`,
  );
}

export const sessionsLocalHandlers: GatewayRequestHandlers = {
  "sessions.local.sources": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsLocalSourcesParams,
        "sessions.local.sources",
        respond,
      )
    ) {
      return;
    }
    respond(true, { sources: listRegisteredLocalSessionSources() });
  },
  "sessions.local.enrollments": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsLocalEnrollmentsParams,
        "sessions.local.enrollments",
        respond,
      )
    ) {
      return;
    }
    const deviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
    respond(true, {
      enrollments: listLocalSessionEnrollments(deviceId ? { deviceId } : {}),
    });
  },
  "sessions.local.enroll": async (options) => {
    const { params, respond, context, client } = options;
    if (
      !assertValidParams(
        params,
        validateSessionsLocalEnrollParams,
        "sessions.local.enroll",
        respond,
      )
    ) {
      return;
    }
    // SAFETY: assertValidParams validated the schema on the line above.
    const request = params as SessionsLocalEnrollParams;
    const profile = await requireProfile(client, context, respond);
    if (!profile) {
      return;
    }
    const source = listRegisteredLocalSessionSources().find(
      (candidate) => candidate.sourceId === request.sourceId,
    );
    if (!source) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown local session source: ${request.sourceId}`),
      );
      return;
    }
    const node = context.nodeRegistry.get(request.deviceId);
    if (!node) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "That device is not connected; connect it with `openclaw connect` first.",
        ),
      );
      return;
    }
    if (!node.commands.includes(source.command)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `That device does not offer ${source.label} sessions; update it or approve its new commands on the Devices page.`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig?.();
    if (cfg) {
      const agentError = authorizeGatewaySessionCreation({ cfg, client, agentId: request.agentId });
      if (agentError) {
        respond(false, undefined, agentError);
        return;
      }
    }
    // Creating an enrollment revokes the device/source's live one; replacing
    // another person's share needs the same authority as sessions.local.revoke.
    const live = listLocalSessionEnrollments({ deviceId: request.deviceId }).find(
      (candidate) =>
        candidate.sourceId === source.sourceId &&
        (candidate.state === "pending" || candidate.state === "active"),
    );
    if (live && live.ownerProfileId !== profile.profileId && !isGatewayAdmin(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${source.label} sessions on that device are already shared by ${live.ownerLabel}; only they or an admin can replace that share.`,
        ),
      );
      return;
    }
    const enrollment = createLocalSessionEnrollment({
      ownerProfileId: profile.profileId,
      ownerLabel: profile.displayName,
      deviceId: request.deviceId,
      pluginId: source.pluginId,
      sourceId: source.sourceId,
      agentId: request.agentId,
    });
    publishEnrollment(context, enrollment);
    // Replacing another person's share stops it for them, and moving your own
    // share to another agent leaves nothing behind in the old agent's store:
    // the replaced projections leave exactly as if Stop sharing had been pressed.
    // A same-owner, same-agent re-share keeps its rows; the device re-tags them.
    if (
      live &&
      (live.ownerProfileId !== profile.profileId || live.agentId !== enrollment.agentId)
    ) {
      const failed = await removeProjectedSessions(options, listProjectedSessionKeys(live));
      if (failed.length > 0) {
        respond(false, undefined, projectionsNotRemovedError(failed));
        return;
      }
    }
    respond(true, { enrollment });
  },
  "sessions.local.connectCode": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsLocalConnectCodeParams,
        "sessions.local.connectCode",
        respond,
      )
    ) {
      return;
    }
    const request = params;
    const profile = await requireProfile(client, context, respond);
    if (!profile) {
      return;
    }
    const registered = listRegisteredLocalSessionSources();
    const sources = request.sourceIds.map((sourceId) =>
      registered.find((candidate) => candidate.sourceId === sourceId),
    );
    const missing = request.sourceIds.filter((_, index) => !sources[index]);
    if (missing.length > 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown local session source: ${missing.join(", ")}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig?.();
    if (cfg) {
      const agentError = authorizeGatewaySessionCreation({ cfg, client, agentId: request.agentId });
      if (agentError) {
        respond(false, undefined, agentError);
        return;
      }
    }
    const minted = await mintNodeJoinUrl(context);
    if (!minted.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, minted.error));
      return;
    }
    const resolvedSources = sources.filter((source) => source !== undefined);
    createLocalSessionConnectIntent({
      setupId: minted.setupId,
      ownerProfileId: profile.profileId,
      ownerLabel: profile.displayName,
      agentId: request.agentId,
      sourceIds: resolvedSources.map((source) => source.sourceId),
      createdAtMs: Date.now(),
      expiresAtMs: minted.expiresAtMs,
    });
    const shareFlags = resolvedSources.map((source) => `--share ${source.sourceId}`).join(" ");
    respond(true, {
      setupId: minted.setupId,
      joinUrl: minted.joinUrl,
      command: `npx openclaw connect ${quoteCliArg(minted.joinUrl)} ${shareFlags} --share-request ${minted.setupId}`,
      expiresAtMs: minted.expiresAtMs,
      sources: resolvedSources,
    });
  },
  "sessions.local.revoke": async (options) => {
    const { params, respond, context, client } = options;
    if (
      !assertValidParams(
        params,
        validateSessionsLocalRevokeParams,
        "sessions.local.revoke",
        respond,
      )
    ) {
      return;
    }
    // SAFETY: assertValidParams validated the schema on the line above.
    const request = params as SessionsLocalRevokeParams;
    const profile = await requireProfile(client, context, respond);
    if (!profile) {
      return;
    }
    const current = readLocalSessionEnrollment(request.enrollmentId);
    if (!current) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "enrollment not found"));
      return;
    }
    if (current.ownerProfileId !== profile.profileId && !isGatewayAdmin(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Only the sharing person or an admin can stop sharing."),
      );
      return;
    }
    const enrollment = transitionLocalSessionEnrollment({
      enrollmentId: request.enrollmentId,
      to: "revoked",
      reason: `stopped by ${profile.displayName}`,
    });
    if (!enrollment) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "enrollment not found"));
      return;
    }
    // The bridge drops the device channel synchronously here, so no frame can
    // land in a row after it is removed.
    publishEnrollment(context, enrollment);
    const failed = await removeProjectedSessions(options, listProjectedSessionKeys(enrollment));
    if (failed.length > 0) {
      respond(false, undefined, projectionsNotRemovedError(failed));
      return;
    }
    respond(true, { enrollment });
  },
  "sessions.local.unshare": async (options) => {
    const { params, respond, context, client } = options;
    if (
      !assertValidParams(
        params,
        validateSessionsLocalUnshareParams,
        "sessions.local.unshare",
        respond,
      )
    ) {
      return;
    }
    // SAFETY: assertValidParams validated the schema on the line above.
    const request = params as SessionsLocalUnshareParams;
    const profile = await requireProfile(client, context, respond);
    if (!profile) {
      return;
    }
    const { entry } = loadSessionEntry(request.sessionKey);
    if (!entry?.localSource) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "That session is not a shared local session."),
      );
      return;
    }
    if (
      sessionCreatorProfileId(entry.createdActor) !== profile.profileId &&
      !isGatewayAdmin(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Only the sharing person or an admin can unshare it."),
      );
      return;
    }
    const bridge = getLocalSessionBridge();
    if (!bridge) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Live local sessions are unavailable."),
      );
      return;
    }
    await bridge.unshare({ entry, byProfileId: profile.profileId });
    const failed = await removeProjectedSessions(options, [request.sessionKey]);
    if (failed.length > 0) {
      respond(false, undefined, projectionsNotRemovedError(failed));
      return;
    }
    respond(true, { ok: true });
  },
};
