import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  scopedAgentParamsForSession,
  type SessionScopeHost,
} from "../../lib/sessions/navigation.ts";
import {
  isUiGlobalScopeConfigured,
  isUiGlobalSessionKey,
  resolveUiConversationIdentity,
  resolveUiGlobalAliasAgentId,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";

export type ChatAbortTargetState = SessionScopeHost & {
  sessionKey: string;
  chatRunId?: string | null;
  chatRunSessionAbortable?: boolean;
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
};

type ChatAbortIntentBase = {
  sourceClient: GatewayBrowserClient;
  recoveryScope: string;
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  readonly conversation: Readonly<ReturnType<typeof resolveUiConversationIdentity>>;
};

export type PendingChatAbort = ChatAbortIntentBase & {
  // Session-key-only stops can become stale and target a newer run after reconnect.
  // Only an exact run identity is safe to replay.
  runId: string;
  /** True when the exact run is embedded-owned and must go through sessions.abort. */
  sessionAbortable?: boolean;
};

export type ChatAbortIntent =
  | PendingChatAbort
  | (ChatAbortIntentBase & {
      runId: null;
      clearQueued?: true;
    });

type ChatAbortRequestTarget = { sessionKey: string; agentId?: string } & (
  | { runId: string; sessionAbortable?: boolean }
  | { runId: null; clearQueued?: true }
);

export type ChatAbortRequestResult =
  | { ok: true; noActiveRun: boolean; warning?: string }
  | { ok: false; error: unknown };

export async function requestChatAbort(
  client: GatewayBrowserClient,
  intent: ChatAbortRequestTarget,
): Promise<ChatAbortRequestResult> {
  try {
    // Recovered embedded runs retain their exact identity on the session-owned route.
    const sessionAbort = intent.runId === null || intent.sessionAbortable === true;
    const response = asOptionalRecord(
      await client.request(sessionAbort ? "sessions.abort" : "chat.abort", {
        ...(sessionAbort ? { key: intent.sessionKey } : { sessionKey: intent.sessionKey }),
        ...(intent.agentId ? { agentId: intent.agentId } : {}),
        ...(intent.runId !== null
          ? { runId: intent.runId }
          : intent.clearQueued
            ? { clearQueued: true }
            : {}),
      }),
    );
    return {
      ok: true,
      // Other response shapes still leave settlement to live events.
      noActiveRun: response?.aborted === false || response?.status === "no-active-run",
      warning: normalizeOptionalString(response?.warning),
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function queuedSessionAbortParams(
  host: SessionScopeHost,
  sessionKey: string,
): { clearQueued?: true } {
  // Agent main aliases reach the global stream only in global scope.
  // Per-sender main sessions own queues that a full stop must clear explicitly.
  const isGlobalSession =
    isUiGlobalSessionKey(sessionKey) ||
    (isUiGlobalScopeConfigured(host) && resolveUiGlobalAliasAgentId(host, sessionKey) !== null);
  return isGlobalSession ? {} : { clearQueued: true };
}

export function chatAbortTargetSession(
  host: ChatAbortTargetState,
  target: Pick<ChatAbortIntentBase, "sessionKey" | "agentId">,
) {
  return host.sessionsResult?.sessions.find((row) =>
    uiConversationMatches(
      host,
      target.sessionKey,
      row.key,
      row.agentId ?? host.sessionsResultAgentId ?? undefined,
      target.agentId,
    ),
  );
}

export function currentChatAbortIntent(
  state: ChatAbortTargetState,
  sourceClient: GatewayBrowserClient,
): ChatAbortIntent {
  const sessionAbortable = state.chatRunSessionAbortable === true;
  const runId = state.chatRunId ?? null;
  const target = {
    sourceClient,
    recoveryScope: state.hello?.auth?.recoveryScope ?? sourceClient.recoveryScope,
    sessionKey: state.sessionKey,
    conversation: resolveUiConversationIdentity(state, state.sessionKey),
    ...scopedAgentParamsForSession(state, state.sessionKey),
  };
  const sessionId = chatAbortTargetSession(state, target)?.sessionId;
  const base = { ...target, ...(sessionId ? { sessionId } : {}) };
  return runId
    ? { ...base, runId, ...(sessionAbortable ? { sessionAbortable: true } : {}) }
    : {
        ...base,
        runId: null,
        ...queuedSessionAbortParams(state, state.sessionKey),
      };
}
