// Emits session lifecycle hooks for channel plugins and agent runtimes.
import type { SessionFreshness } from "../../config/sessions/reset.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";

type ReplySessionEndReason = Extract<
  PluginHookSessionEndReason,
  "new" | "reset" | "idle" | "daily" | "unknown"
>;

export function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): Extract<ReplySessionEndReason, "new" | "reset"> {
  return matchedResetTriggerLower === "/reset" ? "reset" : "new";
}

export function resolveStaleSessionEndReason(params: {
  entry: SessionEntry | undefined;
  freshness?: SessionFreshness;
}): ReplySessionEndReason | undefined {
  return params.entry ? params.freshness?.staleReason : undefined;
}

/** Session identity attached to plugin session hook payloads. */
type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

function buildSessionHookContext(params: SessionHookContext): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  };
}

/** Builds the payload for plugin session-start hooks. */
export function buildSessionStartHookPayload(
  params: SessionHookContext & {
    resumedFrom?: string;
  },
): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resumedFrom: params.resumedFrom,
    },
    context: buildSessionHookContext(params),
  };
}

/** Builds the payload for plugin session-end hooks. */
export function buildSessionEndHookPayload(
  params: SessionHookContext & {
    messageCount?: number;
    durationMs?: number;
    reason?: PluginHookSessionEndReason;
    sessionFile?: string;
    transcriptArchived?: boolean;
    nextSessionId?: string;
    nextSessionKey?: string;
  },
): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageCount: params.messageCount ?? 0,
      durationMs: params.durationMs,
      reason: params.reason,
      sessionFile: params.sessionFile,
      transcriptArchived: params.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
    },
    context: buildSessionHookContext(params),
  };
}
