import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  sanitizeForPromptLiteral,
  wrapUntrustedPromptDataBlock,
} from "../agents/sanitize-for-prompt.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureSystemEventStoreCurrentCheck,
  prepareSystemEventStorePath,
  withSystemEventOwner,
} from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "./session-state-event-kinds.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";

const log = createSubsystemLogger("sessions/state-events");

function reportCreationSignalFailure(error: unknown): void {
  try {
    log.warn(`failed to record session creation: ${String(error)}`);
  } catch {
    // A diagnostic sink cannot fail the already committed creation.
  }
}

/** Notify Home of a new logical session and record its trusted creation attribution. */
export async function recordSessionCreated(
  cfg: OpenClawConfig,
  params: { sessionKey: string; entry: SessionEntry; agentId?: string },
): Promise<void> {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const actor = params.entry.createdActor;
  const event = actor
    ? {
        sessionKey: params.sessionKey,
        sessionId: params.entry.sessionId,
        agentId,
        kind: "created" as const,
        actorType: actor.type,
        ...(actor.id ? { actorId: actor.id } : {}),
        dedupeKey: `created:${agentId}:${params.sessionKey}:${params.entry.sessionId}`,
        summary: "session created",
      }
    : undefined;
  let context: OpenClawStateWorkerContext | undefined;
  if (event) {
    try {
      context = captureOpenClawStateWorkerContext();
    } catch (error) {
      reportCreationSignalFailure(error);
    }
  }
  try {
    await enqueueSessionCreatedNotice({ ...params, cfg, agentId });
  } catch (error) {
    reportCreationSignalFailure(error);
  }
  if (event && context) {
    await recordSessionStateEventAsync(event, { context });
  }
}

function noticeLabel(value: string | undefined): string | undefined {
  const text = value && sanitizeForPromptLiteral(value).trim();
  return text ? truncateUtf16Safe(text, 200) : undefined;
}

/** Creation awareness is one ambient notice, not a subscription to future session activity. */
async function enqueueSessionCreatedNotice(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
}): Promise<void> {
  const { cfg, sessionKey, agentId, entry } = params;
  if (
    cfg.session?.notifyOnCreate === false ||
    entry.incognito ||
    isIncognitoSessionKey(sessionKey) ||
    entry.visibility === "draft" ||
    entry.createdVia === "internal" ||
    entry.createdVia === "cron" ||
    isInternalSessionEffectsKey(sessionKey)
  ) {
    return;
  }
  const mainSessionKey = resolveCanonicalMainSessionKey({
    agentId,
    sessionScope: cfg.session?.scope,
    mainKey: cfg.session?.mainKey,
  });
  if (sessionKey === mainSessionKey) {
    return;
  }
  const actor = entry.createdActor;
  const details = {
    sessionKey,
    title: noticeLabel(entry.label ?? entry.displayName ?? entry.subject),
    createdVia: entry.createdVia,
    creator: actor
      ? {
          type: actor.type,
          ...(actor.type === "human" ? { source: actor.source } : {}),
          id: noticeLabel(actor.id),
          label: noticeLabel(actor.label),
        }
      : undefined,
  };
  const contextKey = `${SESSION_CREATED_NOTICE_CONTEXT_PREFIX}${sessionKey}:${entry.sessionId}`;
  const isStoreCurrent = captureSystemEventStoreCurrentCheck(mainSessionKey, agentId);
  const sessionStorePath = await prepareSystemEventStorePath(mainSessionKey, agentId);
  if (!isStoreCurrent(sessionStorePath)) {
    return;
  }
  enqueueSystemEvent(
    wrapUntrustedPromptDataBlock({ label: "New session created", text: JSON.stringify(details) }),
    withSystemEventOwner(
      {
        sessionKey: mainSessionKey,
        sessionStorePath,
        contextKey,
      },
      agentId,
    ),
  );
}
