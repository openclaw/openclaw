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
  prepareSystemEventStorePath,
  withSystemEventOwner,
} from "../infra/system-event-ownership.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "./session-state-event-kinds.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";

const log = createSubsystemLogger("sessions/state-events");
const CREATION_SUMMARY_MAX_CHARS = 8192;
const CREATION_SUMMARY_HEADER =
  "Recent session creations (bounded summary; older entries may be omitted):";

function reportCreationSignalFailure(error: unknown): void {
  log.warn(`failed to record session creation: ${String(error)}`);
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
  const sessionStorePath = await prepareSystemEventStorePath(mainSessionKey, agentId);
  const options = withSystemEventOwner(
    {
      sessionKey: mainSessionKey,
      sessionStorePath,
      contextKey: SESSION_CREATED_NOTICE_CONTEXT_PREFIX,
      replace: true,
    },
    agentId,
  );
  const pending = peekSystemEventEntries(options.sessionKey).find(
    (event) => event.contextKey === options.contextKey,
  );
  // JSON metadata has no literal blank lines, so each wrapped record stays intact.
  // The queue owns the batch lifetime; read it after store preparation, without another await.
  const notices = pending?.text.split("\n\n").slice(1) ?? [];
  const notice = wrapUntrustedPromptDataBlock({
    label: "New session created",
    text: JSON.stringify(details),
    maxEscapedChars: 2048,
    truncationMarker: "…",
  });
  if (notices.includes(notice)) {
    return;
  }
  notices.push(notice);
  let text = [CREATION_SUMMARY_HEADER, ...notices].join("\n\n");
  while (text.length > CREATION_SUMMARY_MAX_CHARS) {
    notices.shift();
    text = [CREATION_SUMMARY_HEADER, ...notices].join("\n\n");
  }
  enqueueSystemEvent(text, options);
}
