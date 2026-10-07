import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { hasGeneratedMediaCompletionEvent } from "../../agents/internal-event-contract.js";
import {
  resolveAgentMainSessionKey,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  type SessionEntry,
} from "../../config/sessions.js";
import { hasSessionTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import {
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseRuntime,
} from "../../state/openclaw-agent-db.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import {
  respondDeletedAgentSession,
  resolveAgentSessionWorkStartError,
  type RestoredCronContinuation,
} from "../agent-turn/agent-handler-helpers.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadSessionEntry } from "../session-utils.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import { evaluateAgentSessionReuse } from "./agent-session-patch.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type PrepareAgentSessionParams = {
  cfg: OpenClawConfig;
  requestedSessionKey: string;
  requestedSessionId?: string;
  expectedExistingSessionId?: string;
  agentId?: string;
  recipientChannel?: string;
  request: AgentRunRequest;
  canUseCronRunContinuation: boolean;
  lifecycleGeneration: string;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  preAttachmentSession?: { canonicalKey: string; sessionId?: string };
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent?: () => void;
};

export async function prepareAgentSession(params: PrepareAgentSessionParams) {
  params.assertCurrent?.();
  const requestedSessionAgent = resolveRequestedSessionAgentId(
    params.cfg,
    params.requestedSessionKey,
    params.agentId,
  );
  if (!requestedSessionAgent.ok) {
    params.respond(false, undefined, requestedSessionAgent.error);
    return undefined;
  }
  const requestedAgentId = requestedSessionAgent.agentId;
  const selected = loadSessionEntry(params.requestedSessionKey, {
    agentId: requestedAgentId,
    clone: false,
  });
  if (!selected.entry?.sessionId) {
    return prepareAdmittedAgentSession(params, selected, requestedAgentId);
  }
  const database = toDatabaseOptions(
    resolveSqliteScope({
      agentId: parseAgentSessionKey(selected.canonicalKey)?.agentId ?? requestedAgentId,
      sessionKey: selected.canonicalKey,
      storePath: selected.storePath,
    }),
  );
  return withOpenClawAgentDatabaseRuntime(
    database,
    (opened) => {
      params.assertCurrent?.();
      const current = loadSessionEntry(params.requestedSessionKey, {
        agentId: requestedAgentId,
        clone: false,
      });
      const currentDatabase = toDatabaseOptions(
        resolveSqliteScope({
          agentId: parseAgentSessionKey(current.canonicalKey)?.agentId ?? requestedAgentId,
          sessionKey: current.canonicalKey,
          storePath: current.storePath,
        }),
      );
      if (
        current.canonicalKey !== selected.canonicalKey ||
        currentDatabase.agentId !== opened.agentId ||
        resolveOpenClawAgentSqlitePath(currentDatabase) !== opened.path
      ) {
        throw new Error("Session database target changed while preparing; retry the request.");
      }
      return prepareAdmittedAgentSession(params, current, requestedAgentId);
    },
    params.assertCurrent,
  );
}

async function prepareAdmittedAgentSession(
  params: PrepareAgentSessionParams,
  selected: ReturnType<typeof loadSessionEntry>,
  requestedAgentId: string,
) {
  const { cfg, storePath, entry, canonicalKey, legacyKey, storeKeys } = selected;
  const canonicalSessionAgentId = parseAgentSessionKey(canonicalKey)?.agentId ?? requestedAgentId;
  if (params.expectedExistingSessionId && entry?.sessionId !== params.expectedExistingSessionId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `Session "${canonicalKey}" changed before expected work could start.`,
      ),
    );
    return undefined;
  }

  let effectiveBootstrapContextRunKind = params.effectiveBootstrapContextRunKind;
  let restoredCronContinuationIdentity:
    | Pick<RestoredCronContinuation, "lifecycleRevision" | "sessionId">
    | undefined;
  const isGeneratedMediaCronContinuation =
    hasGeneratedMediaCompletionEvent(params.request.internalEvents) &&
    parseCronRunScopeSuffix(canonicalKey).runId !== undefined;
  if (isGeneratedMediaCronContinuation) {
    if (!params.canUseCronRunContinuation) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "cron run completion handoffs are reserved for server-owned callers",
        ),
      );
      return undefined;
    }
    const marker = entry?.cronRunContinuation;
    const continuationSessionId = normalizeOptionalString(entry?.sessionId);
    const staleClaim =
      marker?.phase === "continuing" &&
      marker.ownerLifecycleGeneration !== params.lifecycleGeneration;
    if (staleClaim || (marker?.phase === "ready" && marker.basePersisted !== true)) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          staleClaim
            ? "cron run continuation owner was lost during gateway restart"
            : "cron run continuation base session was not persisted",
        ),
      );
      return undefined;
    }
    if (!marker || marker.phase !== "ready" || !continuationSessionId) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation is not ready"),
      );
      return undefined;
    }
    if (params.requestedSessionId && params.requestedSessionId !== continuationSessionId) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation session changed"),
      );
      return undefined;
    }
    restoredCronContinuationIdentity = {
      lifecycleRevision: marker.lifecycleRevision,
      sessionId: continuationSessionId,
    };
    effectiveBootstrapContextRunKind = "cron";
  }

  const sessionExistedBeforeAttachmentSetup =
    params.preAttachmentSession?.canonicalKey === canonicalKey
      ? params.preAttachmentSession
      : undefined;
  if (
    sessionExistedBeforeAttachmentSetup &&
    (!entry || entry.sessionId !== sessionExistedBeforeAttachmentSetup.sessionId)
  ) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Session "${canonicalKey}" ${entry ? "changed" : "was deleted"} while starting work. Retry.`,
      ),
    );
    return undefined;
  }
  if (
    respondDeletedAgentSession({
      cfg,
      canonicalKey,
      entry,
      acpMetadataSessionKey: legacyKey,
      respond: params.respond,
    })
  ) {
    return undefined;
  }
  const archivedSessionError = resolveAgentSessionWorkStartError(canonicalKey, entry);
  if (archivedSessionError) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return undefined;
  }

  const now = Date.now();
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: sessionDeliveryChannel(entry) ?? params.recipientChannel,
    }),
  });
  const visibleRequest =
    effectiveBootstrapContextRunKind !== "cron" &&
    effectiveBootstrapContextRunKind !== "heartbeat" &&
    !params.request.internalEvents?.length;
  const failedSessionTranscriptMissing = (candidateEntry: SessionEntry | undefined): boolean => {
    if (candidateEntry?.status !== "failed" || !candidateEntry.sessionId?.trim()) {
      return false;
    }
    try {
      return !hasSessionTranscriptEventsSync({
        agentId: canonicalSessionAgentId,
        sessionId: candidateEntry.sessionId,
        sessionKey: canonicalKey,
        storePath,
        sessionEntry: candidateEntry,
      });
    } catch {
      return true;
    }
  };
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: canonicalSessionAgentId });
  const isSystemGatewayRun =
    effectiveBootstrapContextRunKind === "cron" || effectiveBootstrapContextRunKind === "heartbeat";
  const reuse = await evaluateAgentSessionReuse({
    freshEntry: entry,
    cfg,
    sessionAgentId: canonicalSessionAgentId,
    canonicalSessionKey: canonicalKey,
    storePath,
    expectedExistingSessionId: params.expectedExistingSessionId,
    hasRestoredCronContinuation: restoredCronContinuationIdentity !== undefined,
    resetPolicy,
    now,
    requestedSessionId: params.requestedSessionId,
    isSystemGatewayRun,
    visibleRequest,
    failedSessionTranscriptMissing,
  });
  params.assertCurrent?.();
  const sessionId = reuse.sessionId ?? randomUUID();
  return {
    cfg,
    storePath,
    entry,
    canonicalKey,
    storeKeys,
    maintenanceConfig: resolveMaintenanceConfigFromInput(cfg.session?.maintenance),
    canonicalSessionAgentId,
    resetPolicy,
    now,
    freshness: reuse.freshness,
    visibleRequest,
    mainSessionKey,
    isSystemGatewayRun,
    usableRequestedSessionId: reuse.usableRequestedSessionId,
    sessionId,
    isNewSession: reuse.isNewSession,
    rotatedSessionId: Boolean(entry?.sessionId && entry.sessionId !== sessionId),
    touchInteraction: visibleRequest,
    sessionPersistedBeforeGatewayAdmission: entry !== undefined,
    effectiveBootstrapContextRunKind,
    restoredCronContinuationIdentity,
    failedSessionTranscriptMissing,
  };
}
