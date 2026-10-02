import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  sanitizeForPromptLiteral,
  wrapUntrustedPromptDataBlock,
} from "../agents/sanitize-for-prompt.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "./session-state-event-kinds.js";
import { recordSessionStateEvent } from "./session-state-events.js";

/** Notify Home of a new logical session and record its trusted creation attribution. */
export function recordSessionCreated(
  cfg: OpenClawConfig,
  params: { sessionKey: string; entry: SessionEntry; agentId?: string },
): void {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  enqueueSessionCreatedNotice({ ...params, cfg, agentId });
  const actor = params.entry.createdActor;
  if (!actor) {
    return;
  }
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    agentId,
    kind: "created",
    actorType: actor.type,
    ...(actor.id ? { actorId: actor.id } : {}),
    dedupeKey: `created:${agentId}:${params.sessionKey}:${params.entry.sessionId}`,
    summary: "session created",
  });
}

function noticeLabel(value: string | undefined): string | undefined {
  const text = value && sanitizeForPromptLiteral(value).trim();
  return text ? truncateUtf16Safe(text, 200) : undefined;
}

/** Creation awareness is one ambient notice, not a subscription to future session activity. */
function enqueueSessionCreatedNotice(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
}): void {
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
  enqueueSystemEvent(
    wrapUntrustedPromptDataBlock({ label: "New session created", text: JSON.stringify(details) }),
    withSystemEventOwner(
      {
        sessionKey: mainSessionKey,
        contextKey: `${SESSION_CREATED_NOTICE_CONTEXT_PREFIX}${sessionKey}:${entry.sessionId}`,
      },
      agentId,
    ),
  );
}
