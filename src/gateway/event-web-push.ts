import { createHash, randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import {
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type {
  WebPushDetailLevel,
  WebPushNotificationCategory,
  WebPushSendParams,
  WebPushSendResult,
} from "../../packages/gateway-protocol/src/schema/push.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronExecutionId } from "../cron/run-id.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { isNamedOperatorRoleEnforcementEnabled } from "./operator-role-enforcement.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import type { SessionViewerPresenceDeclarations } from "./session-viewer-presence.js";
import {
  listCurrentWebPushTargets,
  withCurrentWebPushAuthority,
  webPushTargetClient,
  webPushSessionAccess,
} from "./web-push-authority.js";
import { currentWebPushAgentIcon, prepareWebPushAgentIcon } from "./web-push-avatar.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
const log = createSubsystemLogger("gateway/web-push");

/** Generic lock-screen text for each attention category, shared by every producer. */
const WEB_PUSH_CATEGORY_TEXT = {
  "agent-finished": {
    title: "OpenClaw agent finished",
    body: "An agent completed its response.",
  },
  "agent-question": {
    title: "OpenClaw needs an answer",
    body: "An agent has a question for you.",
  },
  "human-mentioned": {
    title: "OpenClaw mention",
    body: "Someone mentioned you in a conversation.",
  },
  "scheduled-task-failed": {
    title: "OpenClaw scheduled task failed",
    body: "A scheduled task needs attention.",
  },
} as const satisfies Record<
  WebPushSendParams["category"] | "human-mentioned",
  { title: string; body: string }
>;

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
  path?: string;
};

export type HumanMentionWebPush = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    const questionId = normalizeOptionalString(value.id);
    return {
      category: "agent-question",
      ...WEB_PUSH_CATEGORY_TEXT["agent-question"],
      tag: `openclaw-question-${id}`,
      ...(questionId ? { path: `ask/${encodeURIComponent(questionId)}` } : {}),
    };
  }
  if (
    event === "chat" &&
    value.state === "final" &&
    value.yielded !== true &&
    !isTranscriptOnlyOpenClawAssistantMessage(value.message)
  ) {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      ...WEB_PUSH_CATEGORY_TEXT["agent-finished"],
      tag: `openclaw-agent-finished-${runId}`,
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
    return {
      category: "scheduled-task-failed",
      ...WEB_PUSH_CATEGORY_TEXT["scheduled-task-failed"],
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobTag}`,
      path: `automations${query.size ? `?${query}` : ""}`,
    };
  }
  return null;
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(
  getRuntimeConfig: () => OpenClawConfig,
  viewers?: Pick<SessionViewerPresenceDeclarations, "isViewedOnDevice">,
  getSessionRowProjection?: () => Pick<SessionRowProjection, "readCapabilityEntry"> | undefined,
) {
  const deliver = (
    notification: EventNotification,
    event: string,
    payload?: unknown,
    opts?: GatewayBroadcastOpts,
    mention?: HumanMentionWebPush,
  ): void => {
    let stage = "subscriptions";
    void (async () => {
      if (!(await hasBoundWebPushSubscriptions())) {
        return;
      }
      stage = "sender";
      const sender = await prepareWebPushNotificationSender();
      stage = "authority";
      const agentId = normalizeOptionalString(
        opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
      );
      const sessionKeys = opts?.sessionKeys ?? [];
      const preparedIcon = mention
        ? undefined
        : await prepareWebPushAgentIcon(getRuntimeConfig(), agentId);
      const groupedResults = await withCurrentWebPushAuthority(
        { getRuntimeConfig, sessionKeys, agentId, preparePublication: mention?.prepare },
        (authority) => {
          const { cfg } = authority;
          const recipientProfileId =
            mention &&
            authority.profile?.readCurrentIdentity(mention.recipientProfileId)?.profileId;
          if (mention && !recipientProfileId) {
            return undefined;
          }
          const sessionKey = mention?.sessionKey ?? sessionKeys[0];
          const sessionPath = sessionKey
            ? buildControlUiSessionPath({
                namespace: "chat",
                sessionKey,
                fallbackAgentId: agentId,
                mainKey: cfg.session?.mainKey,
                exactKey: true,
              })
            : undefined;
          if (mention && !sessionPath) {
            return undefined;
          }
          const path = notification.path ?? sessionPath?.slice(1) ?? "sessions";
          const url = resolveControlUiWebPushUrl(cfg, path);
          const targets = listCurrentWebPushTargets({
            ...authority,
            requiredScopes:
              notification.category === "agent-question"
                ? [READ_SCOPE, QUESTIONS_SCOPE]
                : [READ_SCOPE],
            ...(mention ? { visibilityScopes: [ADMIN_SCOPE] } : {}),
          });
          // Only an unambiguous session can be matched against one device's viewer declarations.
          const viewedSessionKey = sessionKeys.length === 1 ? sessionKeys[0] : undefined;
          const agentLabel = normalizeWebPushDisplayLabel(agentId);
          const agentIcon = currentWebPushAgentIcon(cfg, preparedIcon);
          const groups = new Map<
            string,
            {
              title: string;
              body: string;
              icon?: string;
              subscriptions: BoundWebPushSubscription[];
            }
          >();
          for (const target of targets) {
            if (mention && target.userProfileId !== recipientProfileId) {
              continue;
            }
            const { preferences } = target;
            if (
              !webPushCategoryEnabled(preferences, notification.category) ||
              isWebPushQuietHours(preferences) ||
              !webPushAgentAllowed(preferences, agentId)
            ) {
              continue;
            }
            const client = webPushTargetClient(target);
            if (
              sessionKeys.length > 0 &&
              !canReceiveSessionEvent({
                cfg,
                client,
                prepared: webPushSessionAccess(authority, client),
                sessionKeys,
                ...(agentId ? { agentId } : {}),
                event,
                payload,
              })
            ) {
              continue;
            }
            if (isNamedOperatorRoleEnforcementEnabled(cfg) && sessionKeys.length === 0) {
              // Multi-user events without an authoritative session owner are not broadcast offline.
              continue;
            }
            if (
              notification.category === "agent-finished" &&
              viewedSessionKey !== undefined &&
              viewers?.isViewedOnDevice(target.subscription.deviceId, viewedSessionKey) === true
            ) {
              // This device already shows the reply; other devices and categories still notify.
              continue;
            }
            let identifiedBody = notification.identifiedBody;
            if (
              notification.category === "agent-finished" &&
              preferences.detailLevel !== "private" &&
              sessionKeys.length === 1 &&
              sessionKey
            ) {
              // Read resident metadata only after authorization; never infer a title from content.
              const authorized = authority.sessions.get(sessionKey)?.target;
              const entry = authorized
                ? getSessionRowProjection?.()?.readCapabilityEntry({
                    agentId: authorized.agentId,
                    storePath: authorized.storePath,
                    key: authorized.canonicalKey,
                  })?.entry
                : undefined;
              const completionLabel = normalizeWebPushDisplayLabel(
                entry?.sessionId === authorized?.entry.sessionId ? entry?.label : undefined,
              );
              if (completionLabel) {
                identifiedBody = `${completionLabel}: ${notification.body}`;
              }
            }
            const prefix = preferences.label ? `${preferences.label} · ` : "";
            const title = `${prefix}${notification.title}`;
            const body =
              preferences.detailLevel === "private"
                ? notification.body
                : (identifiedBody ??
                  (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
            const icon = preferences.detailLevel === "private" ? undefined : agentIcon;
            const key = JSON.stringify({ title, body, icon });
            const group = groups.get(key) ?? { title, body, icon, subscriptions: [] };
            group.subscriptions.push(target.subscription);
            groups.set(key, group);
          }
          // The mention owner fences dismissal, expiry, session replacement and Gateway
          // teardown after preparation. No awaited work may separate it from the send.
          if (mention && !mention.isCurrent()) {
            return undefined;
          }
          const topic = createHash("sha256")
            .update(notification.tag)
            .digest("base64url")
            .slice(0, 32);
          return {
            start: () => {
              stage = "delivery";
              return Promise.all(
                [...groups.values()].map((group) =>
                  sender({
                    subscriptions: group.subscriptions,
                    payload: {
                      title: group.title,
                      body: group.body,
                      ...(group.icon ? { icon: group.icon } : {}),
                      tag: notification.tag,
                      renotify: false,
                      url,
                    },
                    deliveryOptions: {
                      TTL: EVENT_PUSH_TTL_SECONDS,
                      urgency: notification.category.includes("failed") ? "high" : "normal",
                      topic,
                    },
                  }),
                ),
              );
            },
          };
        },
      );
      if (!groupedResults) {
        return;
      }
      const results = groupedResults.flat();
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) {
        log.warn("event Web Push delivery failed", {
          category: notification.category,
          attempted: results.length,
          failed,
        });
      }
    })().catch((error: unknown) => {
      log.warn("event Web Push delivery could not complete", {
        category: notification.category,
        stage,
        error: formatErrorMessage(error),
        errorName: readErrorName(error),
        errorCode: extractErrorCode(error),
        stack: error instanceof Error ? error.stack : undefined,
        retry: false,
      });
    });
  };

  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (notification) {
        deliver(notification, event, payload, opts);
      }
    },
    deliverMention(this: void, mention: HumanMentionWebPush): void {
      const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
      const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
      const id = createHash("sha256").update(mention.id).digest("base64url");
      deliver(
        {
          category: "human-mentioned",
          ...WEB_PUSH_CATEGORY_TEXT["human-mentioned"],
          identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
          tag: `openclaw-mention-${id}`,
        },
        "human-mentioned",
        undefined,
        { agentId: mention.agentId, sessionKeys: [mention.sessionKey] },
        mention,
      );
    },
  };
}

/**
 * Chooses lock-screen text for a profile-targeted send. This is the single switch point
 * for caller-provided text, which only a **Detailed** recipient sees. **Names only**
 * (`identified`) gets the category's generic text with the permitted agent label, exactly
 * like core attention alerts, and **Private** gets the generic text alone.
 */
function resolveProfileWebPushText(
  params: Pick<WebPushSendParams, "category" | "title" | "body">,
  detailLevel: WebPushDetailLevel,
  agentLabel: string | undefined,
): { title: string; body: string } {
  const generic = WEB_PUSH_CATEGORY_TEXT[params.category];
  if (detailLevel === "private") {
    return generic;
  }
  const labeledBody = agentLabel ? `${agentLabel}: ${generic.body}` : generic.body;
  if (detailLevel !== "detailed") {
    return { title: generic.title, body: labeledBody };
  }
  // Lock screens show one line: flatten line breaks and other controls to spaces before
  // the shared sanitizer escapes the remaining spoofing characters.
  const flatten = (text: string | undefined) =>
    text?.replace(/ *[\p{Cc}\p{Zl}\p{Zp}][\p{Cc}\p{Zl}\p{Zp} ]*/gu, " ");
  return {
    title: normalizeWebPushDisplayLabel(flatten(params.title)) ?? generic.title,
    body: normalizeWebPushDisplayLabel(flatten(params.body), 240) ?? labeledBody,
  };
}

/**
 * Sends one notification to a user profile's current browsers. Recipients, merged-profile
 * aliases, OpenClaw ID grants, preferences, quiet hours and expired-endpoint cleanup all
 * come from the same authority and transport owners as attention events.
 */
export async function sendProfileWebPush(
  getRuntimeConfig: () => OpenClawConfig,
  params: WebPushSendParams,
): Promise<WebPushSendResult> {
  const counts = { sent: 0, failed: 0, skipped: 0, pruned: 0 };
  if (!(await hasBoundWebPushSubscriptions())) {
    return counts;
  }
  const sender = await prepareWebPushNotificationSender();
  const { category, agentId } = params;
  const tag = `openclaw-send-${params.tag ?? randomUUID()}`;
  const results = await withCurrentWebPushAuthority({ getRuntimeConfig }, (authority) => {
    // A retried preparation sees a fresher snapshot; only its final pass counts.
    counts.skipped = 0;
    const recipientProfileId = authority.profile?.readCurrentIdentity(params.profileId)?.profileId;
    if (!recipientProfileId) {
      return undefined;
    }
    const { cfg } = authority;
    const url = resolveControlUiWebPushUrl(cfg, params.path ?? "sessions");
    const agentLabel = normalizeWebPushDisplayLabel(agentId);
    const groups = new Map<
      string,
      { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
    >();
    const targets = listCurrentWebPushTargets({
      ...authority,
      requiredScopes: category === "agent-question" ? [READ_SCOPE, QUESTIONS_SCOPE] : [READ_SCOPE],
    });
    // The explicit recipient is the authoritative owner, so the sessionless multi-user
    // suppression used for broadcast events does not apply here. Devices the authority
    // drops (revoked, ID-unbound, or missing a required scope such as operator.questions
    // for agent-question) are not the recipient's to count: they enter no counter.
    for (const target of targets) {
      if (target.userProfileId !== recipientProfileId) {
        continue;
      }
      const { preferences } = target;
      if (
        !webPushCategoryEnabled(preferences, category) ||
        isWebPushQuietHours(preferences) ||
        !webPushAgentAllowed(preferences, agentId)
      ) {
        counts.skipped += 1;
        continue;
      }
      const text = resolveProfileWebPushText(params, preferences.detailLevel, agentLabel);
      const title = `${preferences.label ? `${preferences.label} · ` : ""}${text.title}`;
      const key = JSON.stringify([title, text.body]);
      const group = groups.get(key) ?? { title, body: text.body, subscriptions: [] };
      group.subscriptions.push(target.subscription);
      groups.set(key, group);
    }
    const topic = createHash("sha256").update(tag).digest("base64url").slice(0, 32);
    return {
      start: () =>
        Promise.all(
          [...groups.values()].map((group) =>
            sender({
              subscriptions: group.subscriptions,
              payload: { title: group.title, body: group.body, tag, renotify: false, url },
              deliveryOptions: {
                TTL: params.ttlSeconds ?? EVENT_PUSH_TTL_SECONDS,
                urgency: params.urgency ?? "normal",
                topic,
              },
            }),
          ),
        ),
    };
  });
  for (const result of results?.flat() ?? []) {
    if (result.ok) {
      counts.sent += 1;
      continue;
    }
    counts.failed += 1;
    // The transport owner already attempted conditional removal of these endpoints.
    if (result.statusCode === 404 || result.statusCode === 410) {
      counts.pruned += 1;
    }
  }
  return counts;
}
