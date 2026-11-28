import { createHash } from "node:crypto";
import {
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isWebPushQuietHours,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import {
  canNotificationRecipientReceive,
  currentNotificationRecipientProfileId,
  readNotificationSessionLabel,
  resolveNotificationPath,
} from "./notification-authority.js";
import type { NotificationDestination } from "./notification-delivery.js";
import { renderNotificationCopy, type NotificationIntent } from "./notification-intent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionViewerPresenceDeclarations } from "./session-viewer-presence.js";
import {
  listCurrentWebPushTargets,
  withCurrentWebPushAuthority,
  webPushTargetClient,
} from "./web-push-authority.js";
import { currentWebPushAgentIcon, prepareWebPushAgentIcon } from "./web-push-avatar.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
const log = createSubsystemLogger("gateway/web-push");

/** Sends event intents to offline browsers without expanding live session visibility. */
export function createWebPushNotificationDestination(
  getRuntimeConfig: () => OpenClawConfig,
  viewers?: Pick<SessionViewerPresenceDeclarations, "isViewedOnDevice">,
  getSessionRowProjection?: () => Pick<SessionRowProjection, "readCapabilityEntry"> | undefined,
): NotificationDestination {
  return {
    deliver(intent: NotificationIntent): void {
      let stage = "subscriptions";
      void (async () => {
        if (!(await hasBoundWebPushSubscriptions())) {
          return;
        }
        stage = "sender";
        const sender = await prepareWebPushNotificationSender();
        stage = "authority";
        const { agentId, sessionKeys, recipient } = intent;
        // Targeted human notifications are about their sender, so they carry no agent avatar.
        const preparedIcon = recipient
          ? undefined
          : await prepareWebPushAgentIcon(getRuntimeConfig(), agentId);
        const groupedResults = await withCurrentWebPushAuthority(
          { getRuntimeConfig, sessionKeys, agentId, preparePublication: recipient?.prepare },
          (authority) => {
            const { cfg } = authority;
            const recipientProfileId = currentNotificationRecipientProfileId(
              intent,
              authority.profile,
            );
            if (recipient && !recipientProfileId) {
              return undefined;
            }
            const path = resolveNotificationPath(intent, cfg);
            if (path === undefined) {
              return undefined;
            }
            const url = resolveControlUiWebPushUrl(cfg, path);
            const targets = listCurrentWebPushTargets({
              ...authority,
              requiredScopes: intent.requiredScopes,
              ...(intent.visibilityScopes ? { visibilityScopes: intent.visibilityScopes } : {}),
            });
            // Only an unambiguous session can be matched against one device's viewer declarations.
            const viewedSessionKey = sessionKeys.length === 1 ? sessionKeys[0] : undefined;
            const agentIcon = currentWebPushAgentIcon(cfg, preparedIcon);
            let sessionLabel: { value: string | undefined } | undefined;
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
              if (recipient && target.userProfileId !== recipientProfileId) {
                continue;
              }
              const { preferences } = target;
              if (
                !webPushCategoryEnabled(preferences, intent.category) ||
                isWebPushQuietHours(preferences) ||
                !webPushAgentAllowed(preferences, agentId)
              ) {
                continue;
              }
              if (
                !canNotificationRecipientReceive(intent, authority, webPushTargetClient(target))
              ) {
                continue;
              }
              if (
                intent.category === "agent-finished" &&
                viewedSessionKey !== undefined &&
                viewers?.isViewedOnDevice(target.subscription.deviceId, viewedSessionKey) === true
              ) {
                // This device already shows the reply; other devices and categories still notify.
                continue;
              }
              if (preferences.detailLevel !== "private") {
                sessionLabel ??= {
                  value: readNotificationSessionLabel(
                    intent,
                    authority,
                    getSessionRowProjection?.(),
                  ),
                };
              }
              const copy = renderNotificationCopy(
                intent,
                preferences.detailLevel,
                sessionLabel?.value,
              );
              const prefix = preferences.label ? `${preferences.label} · ` : "";
              const title = `${prefix}${copy.title}`;
              const body = copy.body;
              const icon = preferences.detailLevel === "private" ? undefined : agentIcon;
              const key = JSON.stringify({ title, body, icon });
              const group = groups.get(key) ?? { title, body, icon, subscriptions: [] };
              group.subscriptions.push(target.subscription);
              groups.set(key, group);
            }
            // The recipient owner fences dismissal, expiry, session replacement and Gateway
            // teardown after preparation. No awaited work may separate it from the send.
            if (recipient && !recipient.isCurrent()) {
              return undefined;
            }
            const topic = createHash("sha256").update(intent.tag).digest("base64url").slice(0, 32);
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
                        tag: intent.tag,
                        renotify: false,
                        url,
                      },
                      deliveryOptions: {
                        TTL: EVENT_PUSH_TTL_SECONDS,
                        urgency: intent.urgency,
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
            category: intent.category,
            attempted: results.length,
            failed,
          });
        }
      })().catch((error: unknown) => {
        log.warn("event Web Push delivery could not complete", {
          category: intent.category,
          stage,
          error: formatErrorMessage(error),
          errorName: readErrorName(error),
          errorCode: extractErrorCode(error),
          stack: error instanceof Error ? error.stack : undefined,
          retry: false,
        });
      });
    },
  };
}
