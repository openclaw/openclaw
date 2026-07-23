/**
 * Optional Command Center live-activity leases for active OpenClaw runtime work.
 */
import type { DurableMessageSendIntent } from "../channels/message/types.js";
import type { OutboundSessionContext } from "./outbound/session-context.js";

const ACTIVITY_ENDPOINT_ENV = "OPENCLAW_AGENT_ACTIVITY_ENDPOINT";
const ACTIVITY_BEARER_ENV = "OPENCLAW_AGENT_ACTIVITY_BEARER";
const ACTIVITY_POST_TIMEOUT_MS = 1500;

type RuntimeActivitySession = {
  sessionId: string;
  kind: "manual";
  status: "running";
  phase: string;
  currentAction: string;
  actionIcon: string;
  startedAt: string;
  runId?: string;
  threadId?: string;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeActivityKey(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "-")
    .slice(0, 96);
}

function formatChannelName(channel: string | undefined): string {
  const normalized = normalizeOptionalString(channel)?.toLowerCase();
  if (!normalized) {
    return "session";
  }
  return (
    (normalized === "slack"
      ? "Slack"
      : normalized
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => part[0]?.toUpperCase() + part.slice(1))
          .join(" ")) || "session"
  );
}

function channelFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split(":");
  return normalizeOptionalString(parts[2]);
}

function endpointConfig(
  env: NodeJS.ProcessEnv = process.env,
): { endpoint: string; bearer: string } | undefined {
  const endpoint = normalizeOptionalString(env[ACTIVITY_ENDPOINT_ENV]);
  const bearer = normalizeOptionalString(env[ACTIVITY_BEARER_ENV]);
  return endpoint && bearer ? { endpoint, bearer } : undefined;
}

function postActivityLease(session: RuntimeActivitySession): void {
  const config = endpointConfig();
  if (!config || typeof fetch !== "function") {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_POST_TIMEOUT_MS);
  void fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state: "working",
      currentAction: session.currentAction,
      actionIcon: session.actionIcon,
      sessions: [session],
    }),
    signal: controller.signal,
  })
    .catch(() => {
      // Live Activity must never affect the runtime path it observes.
    })
    .finally(() => clearTimeout(timeout));
}

export function emitRuntimeTurnActivityLease(params: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
}): void {
  const stableId = normalizeOptionalString(params.sessionKey) ?? params.sessionId;
  const channel = channelFromSessionKey(params.sessionKey);
  const channelLabel = formatChannelName(channel);
  postActivityLease({
    sessionId: sanitizeActivityKey(`runtime:${stableId}`),
    kind: "manual",
    status: "running",
    phase: "running",
    currentAction: channel ? `Running ${channelLabel} session` : "Running OpenClaw session",
    actionIcon: "code",
    startedAt: new Date().toISOString(),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.sessionKey ? { threadId: params.sessionKey } : {}),
  });
}

export function emitRuntimeReplyActivityLease(params: {
  intent: DurableMessageSendIntent;
  session?: OutboundSessionContext;
}): void {
  const sessionKey = params.session?.key ?? params.session?.policyKey;
  const channelLabel = formatChannelName(params.intent.channel);
  const stableId =
    normalizeOptionalString(sessionKey) ?? `${params.intent.channel}:${params.intent.to}`;
  postActivityLease({
    sessionId: sanitizeActivityKey(`reply:${stableId}`),
    kind: "manual",
    status: "running",
    phase: "replying",
    currentAction: `Replying in ${channelLabel}`,
    actionIcon: "message",
    startedAt: new Date().toISOString(),
    runId: params.intent.id,
    ...(sessionKey ? { threadId: sessionKey } : {}),
  });
}

export const testing = {
  endpointConfig,
};
