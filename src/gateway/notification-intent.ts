// Transport-neutral notification content. Producers turn Gateway events into
// intents once; every destination renders and gates the same intent.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WebPushDetailLevel,
  WebPushNotificationCategory,
} from "../../packages/gateway-protocol/src/schema/push.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { normalizeWebPushDisplayLabel } from "../infra/push-web-preferences.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { APPROVALS_SCOPE, QUESTIONS_SCOPE } from "./method-scopes.js";
import type { notificationSessionAccess } from "./notification-authority.js";
import { isNamedOperatorRoleEnforcementEnabled } from "./operator-role-enforcement.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";

type NotificationCategory = WebPushNotificationCategory;
type NotificationDetailLevel = WebPushDetailLevel;

/** Current facts a destination supplies when asking whether one recipient may see an intent. */
type NotificationRecipientAccess = {
  cfg: OpenClawConfig;
  /** The recipient as a Gateway client, carrying its current scopes, profile and principal. */
  client: GatewayClient;
  /** Session sharing facts from the same authority snapshot, built on first use. */
  sessionAccess: () => ReturnType<typeof notificationSessionAccess>;
};

/** The one person a targeted intent reaches; untargeted intents reach every authorized recipient. */
type NotificationRecipient = {
  profileId: string;
  /** Joins the producer's publication before the final synchronous authority check. */
  prepare: () => Promise<void>;
  /** Fences dismissal, expiry and teardown; checked synchronously right before sending. */
  isCurrent: () => boolean;
};

/**
 * A notification independent of its transport.
 *
 * Copy is fixed when the intent is produced, except for `labelsSession`, which a
 * destination resolves from authorized session metadata in its authority snapshot.
 */
export type NotificationIntent = {
  category: NotificationCategory;
  title: string;
  /** Copy for the `private` detail level. Names no agent, session, person or job. */
  body: string;
  /** Copy for the `identified` and `detailed` detail levels. */
  identifiedBody: string;
  /** Identified copy prefixes `body` with the session's explicit label when one is authorized. */
  labelsSession?: boolean;
  /** Stable dedupe key; a later intent with the same tag replaces the earlier one. */
  tag: string;
  /** Control UI path without a leading slash. Defaults to the session, then the sessions list. */
  path?: string;
  agentId?: string;
  sessionKeys: readonly string[];
  /** Scopes every recipient needs. */
  requiredScopes: readonly string[];
  /** Extra scopes that widen visibility when the recipient currently holds them. */
  visibilityScopes?: readonly string[];
  recipient?: NotificationRecipient;
  urgency: "normal" | "high";
  /** The producer's visibility rule. Destinations reach it only through the shared recheck. */
  canReceive: (access: NotificationRecipientAccess) => boolean;
};

function identifiedWithAgent(body: string, agentId: string | undefined): string {
  const agentLabel = normalizeWebPushDisplayLabel(agentId);
  return agentLabel ? `${agentLabel}: ${body}` : body;
}

function sessionEventVisibility(params: {
  event: string;
  payload?: unknown;
  agentId?: string;
  sessionKeys: readonly string[];
}): NotificationIntent["canReceive"] {
  const { event, payload, agentId, sessionKeys } = params;
  return ({ cfg, client, sessionAccess }) => {
    if (
      sessionKeys.length > 0 &&
      !canReceiveSessionEvent({
        cfg,
        client,
        prepared: sessionAccess(),
        sessionKeys,
        ...(agentId ? { agentId } : {}),
        event,
        payload,
      })
    ) {
      return false;
    }
    // Multi-user events without an authoritative session owner are not broadcast offline.
    return !(isNamedOperatorRoleEnforcementEnabled(cfg) && sessionKeys.length === 0);
  };
}

/** Maps a broadcast Gateway event to its attention notification, if it has one. */
export function resolveEventNotificationIntent(
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
): NotificationIntent | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  const agentId = normalizeOptionalString(opts?.agentId ?? value.agentId);
  const sessionKeys = opts?.sessionKeys ?? [];
  const routing = {
    ...(agentId ? { agentId } : {}),
    sessionKeys,
    canReceive: sessionEventVisibility({ event, payload, agentId, sessionKeys }),
  };
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    const questionId = normalizeOptionalString(value.id);
    const body = "An agent has a question for you.";
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body,
      identifiedBody: identifiedWithAgent(body, agentId),
      tag: `openclaw-question-${id}`,
      ...(questionId ? { path: `ask/${encodeURIComponent(questionId)}` } : {}),
      requiredScopes: [READ_SCOPE, QUESTIONS_SCOPE],
      urgency: "normal",
      ...routing,
    };
  }
  if (
    event === "chat" &&
    value.state === "final" &&
    value.yielded !== true &&
    !isTranscriptOnlyOpenClawAssistantMessage(value.message)
  ) {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
    const body = "An agent completed its response.";
    return {
      category: "agent-finished",
      title: "OpenClaw agent finished",
      body,
      identifiedBody: identifiedWithAgent(body, agentId),
      labelsSession: true,
      tag: `openclaw-agent-finished-${runId}`,
      requiredScopes: [READ_SCOPE],
      urgency: "normal",
      ...routing,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = isRecord(value.job) ? value.job : null;
    const jobId = normalizeOptionalString(value.jobId);
    const jobTag = normalizeWebPushDisplayLabel(jobId) ?? "failed";
    const jobName = normalizeWebPushDisplayLabel(job?.name);
    const query = new URLSearchParams();
    if (jobId) {
      query.set("job", jobId);
      const runId =
        normalizeOptionalString(value.runId) ??
        (typeof value.runAtMs === "number" &&
        Number.isSafeInteger(value.runAtMs) &&
        value.runAtMs >= 0
          ? createCronExecutionId(jobId, value.runAtMs)
          : undefined);
      if (runId) {
        query.set("run", runId);
      }
    }
    const body = "A scheduled task needs attention.";
    return {
      category: "scheduled-task-failed",
      title: "OpenClaw scheduled task failed",
      body,
      identifiedBody: jobName ? `${jobName} needs attention.` : identifiedWithAgent(body, agentId),
      tag: `openclaw-cron-failed-${jobTag}`,
      path: `automations${query.size ? `?${query}` : ""}`,
      requiredScopes: [READ_SCOPE],
      urgency: "high",
      ...routing,
    };
  }
  return null;
}

export type HumanMentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

/** Targets only the mentioned person; admin scope widens that person's session visibility. */
export function humanMentionNotificationIntent(
  mention: HumanMentionNotification,
): NotificationIntent {
  const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
  const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
  const id = createHash("sha256").update(mention.id).digest("base64url");
  const agentId = normalizeOptionalString(mention.agentId);
  const sessionKeys = [mention.sessionKey];
  return {
    category: "human-mentioned",
    title: "OpenClaw mention",
    body: "Someone mentioned you in a conversation.",
    identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
    tag: `openclaw-mention-${id}`,
    ...(agentId ? { agentId } : {}),
    sessionKeys,
    requiredScopes: [READ_SCOPE],
    visibilityScopes: [ADMIN_SCOPE],
    recipient: {
      profileId: mention.recipientProfileId,
      prepare: mention.prepare,
      isCurrent: mention.isCurrent,
    },
    urgency: "normal",
    canReceive: sessionEventVisibility({ event: "human-mentioned", agentId, sessionKeys }),
  };
}

/** Request or terminal copy for one approval; the caller supplies its visibility rule. */
export function approvalNotificationIntent(params: {
  approvalId: string;
  terminal: boolean;
  agentId?: string;
  sessionKey?: string;
  canReceive: NotificationIntent["canReceive"];
}): NotificationIntent & { path: string } {
  // Terminal copy replaces the request in place and names no agent.
  const agentLabel = params.terminal ? undefined : normalizeWebPushDisplayLabel(params.agentId);
  const agent = agentLabel ? ` for ${agentLabel}` : "";
  return {
    category: "approval-requested",
    title: `OpenClaw approval ${params.terminal ? "updated" : "requested"}`,
    body: params.terminal
      ? "This approval is no longer pending."
      : "Open OpenClaw to review this request.",
    identifiedBody: params.terminal
      ? `Approval${agent} is no longer pending.`
      : `Open OpenClaw to review an approval${agent}.`,
    tag: `openclaw-approval-${params.approvalId}`,
    path: `approve/${encodeURIComponent(params.approvalId)}`,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKeys: params.sessionKey ? [params.sessionKey] : [],
    requiredScopes: [APPROVALS_SCOPE, READ_SCOPE],
    urgency: "high",
    canReceive: params.canReceive,
  };
}

/** Renders intent copy at one detail level; `sessionLabel` applies only to `labelsSession` intents. */
export function renderNotificationCopy(
  intent: NotificationIntent,
  detailLevel: NotificationDetailLevel,
  sessionLabel?: string,
): { title: string; body: string } {
  if (detailLevel === "private") {
    return { title: intent.title, body: intent.body };
  }
  return {
    title: intent.title,
    body:
      intent.labelsSession && sessionLabel
        ? `${sessionLabel}: ${intent.body}`
        : intent.identifiedBody,
  };
}
