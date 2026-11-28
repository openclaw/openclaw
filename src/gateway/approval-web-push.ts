// Delivers generic approval notifications to Web Push subscriptions whose
// persisted browser binding still has current approval and visibility access.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isWebPushQuietHours,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  deleteWebPushApprovalDeliveryTargets,
  hasBoundWebPushSubscriptions,
  listTerminalWebPushApprovalDeliveryIds,
  listWebPushApprovalDeliveryTargets,
  prepareWebPushApprovalDeliveries,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { canNotificationRecipientReceive } from "./notification-authority.js";
import {
  approvalNotificationIntent,
  renderNotificationCopy,
  type NotificationIntent,
} from "./notification-intent.js";
import { canAccessOperatorApproval } from "./operator-approval-authorization.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import {
  canAccessApprovalSession,
  isApprovalRecordVisibleToClient,
  readOperatorApprovalRequestSource,
} from "./server-methods/approval-record-lookup.js";
import {
  listCurrentWebPushTargets,
  webPushTargetClient,
  withCurrentWebPushAuthority,
  type CurrentWebPushTarget,
  type WebPushAuthority,
} from "./web-push-authority.js";
import { currentWebPushAgentIcon, prepareWebPushAgentIcon } from "./web-push-avatar.js";

const WEB_PUSH_APPROVAL_TIMEOUT_MS = 10_000;
const WEB_PUSH_TERMINAL_TTL_SECONDS = 5 * 60;

type PreparedWebPushNotificationSender = Awaited<
  ReturnType<typeof prepareWebPushNotificationSender>
>;

type ApprovalRequestWebPushDelivery = {
  record: ExecApprovalRecord<unknown>;
  sender: PreparedWebPushNotificationSender;
};

function approvalNotificationCopy(params: {
  intent: NotificationIntent;
  preferences: CurrentWebPushTarget["preferences"];
  icon?: string;
}) {
  const label = params.preferences.label ? `${params.preferences.label} · ` : "";
  const copy = renderNotificationCopy(params.intent, params.preferences.detailLevel);
  return {
    ...(params.preferences.detailLevel !== "private" && params.icon ? { icon: params.icon } : {}),
    title: `${label}${copy.title}`,
    body: copy.body,
  };
}

function approvalWebPushTopic(approvalId: string): string {
  return createHash("sha256")
    .update(`openclaw-approval:${approvalId}`)
    .digest("base64url")
    .slice(0, 32);
}

type ApprovalNotificationGroup = {
  copy: ReturnType<typeof approvalNotificationCopy>;
  subscriptions: BoundWebPushSubscription[];
};

function sendApprovalNotificationGroups(params: {
  sender: PreparedWebPushNotificationSender;
  cfg: OpenClawConfig;
  approvalId: string;
  intent: ReturnType<typeof approvalNotificationIntent>;
  ttlSeconds: number;
  groups: Iterable<ApprovalNotificationGroup>;
}) {
  return Promise.all(
    [...params.groups].map(({ copy, subscriptions }) =>
      params.sender({
        subscriptions,
        payload: {
          ...copy,
          renotify: false,
          tag: params.intent.tag,
          url: resolveControlUiWebPushUrl(params.cfg, params.intent.path),
        },
        deliveryOptions: {
          TTL: params.ttlSeconds,
          urgency: params.intent.urgency,
          timeout: WEB_PUSH_APPROVAL_TIMEOUT_MS,
          topic: approvalWebPushTopic(params.approvalId),
        },
      }),
    ),
  );
}

async function deliverBoundApprovalWebPush<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  getRuntimeConfig: () => OpenClawConfig;
}): Promise<ApprovalRequestWebPushDelivery | null> {
  if (params.record.resolvedAtMs !== undefined || params.record.expiresAtMs <= Date.now()) {
    return null;
  }
  if (!(await hasBoundWebPushSubscriptions())) {
    return null;
  }
  const sendWebPushNotifications = await prepareWebPushNotificationSender();
  const source = isRecord(params.record.request) ? params.record.request : undefined;
  const agentId = normalizeOptionalString(source?.agentId);
  const sessionKey = normalizeOptionalString(source?.sessionKey);
  const intent = approvalNotificationIntent({
    approvalId: params.record.id,
    terminal: false,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    canReceive: ({ cfg, client, sessionAccess }) =>
      isApprovalRecordVisibleToClient({
        record: params.record,
        client,
        cfg,
        prepared: sessionAccess(),
      }),
  });
  const preparation = { ...params, agentId, sessionKeys: intent.sessionKeys };
  const eligibleTargets = (authority: WebPushAuthority) =>
    listCurrentWebPushTargets({
      ...authority,
      requiredScopes: intent.requiredScopes,
    }).filter((target) => {
      const { preferences } = target;
      const client = webPushTargetClient(target);
      return (
        webPushCategoryEnabled(preferences, intent.category) &&
        !isWebPushQuietHours(preferences) &&
        webPushAgentAllowed(preferences, agentId) &&
        canNotificationRecipientReceive(intent, authority, client)
      );
    });
  const subscriptions = await withCurrentWebPushAuthority(preparation, (authority) => ({
    start: () => eligibleTargets(authority).map((target) => target.subscription),
  }));
  if (!subscriptions?.length) {
    return null;
  }

  const preparedIds = new Set(
    await prepareWebPushApprovalDeliveries({
      approvalId: params.record.id,
      subscriptions,
      preparedAtMs: Date.now(),
    }),
  );
  if (preparedIds.size === 0) {
    return null;
  }
  const preparedById = new Map(
    subscriptions
      .filter((subscription) => preparedIds.has(subscription.subscriptionId))
      .map((subscription) => [subscription.subscriptionId, subscription]),
  );
  const preparedIcon = await prepareWebPushAgentIcon(params.getRuntimeConfig(), agentId);
  const groupedResults = await withCurrentWebPushAuthority(preparation, (authority) => {
    const { cfg } = authority;
    const currentEligibleTargets = eligibleTargets({
      ...authority,
      subscriptions: authority.subscriptions.filter((subscription) => {
        const prepared = preparedById.get(subscription.subscriptionId);
        return (
          prepared?.deviceId === subscription.deviceId &&
          prepared.userProfileId === subscription.userProfileId
        );
      }),
    });
    // Receipt persistence can yield. Recheck recipients and approval lifetime in
    // the network continuation so revoked or resolved requests never dispatch.
    const now = Date.now();
    if (
      currentEligibleTargets.length === 0 ||
      params.record.resolvedAtMs !== undefined ||
      params.record.expiresAtMs <= now
    ) {
      return undefined;
    }
    const ttlSeconds = Math.ceil((params.record.expiresAtMs - now) / 1_000);
    const requestGroups = new Map<string, ApprovalNotificationGroup>();
    for (const { subscription, preferences } of currentEligibleTargets) {
      const copy = approvalNotificationCopy({
        intent,
        preferences,
        icon: currentWebPushAgentIcon(cfg, preparedIcon),
      });
      const key = JSON.stringify(copy);
      const group = requestGroups.get(key) ?? { copy, subscriptions: [] };
      group.subscriptions.push(subscription);
      requestGroups.set(key, group);
    }
    return {
      start: () =>
        sendApprovalNotificationGroups({
          sender: sendWebPushNotifications,
          cfg,
          approvalId: params.record.id,
          intent,
          ttlSeconds,
          groups: requestGroups.values(),
        }),
    };
  });
  if (!groupedResults) {
    return null;
  }
  const results = groupedResults.flat();
  const definitelyRejectedSubscriptionIds = results
    .filter((result) => !result.ok && result.statusCode !== undefined)
    .map((result) => result.subscriptionId);
  await deleteWebPushApprovalDeliveryTargets({
    approvalId: params.record.id,
    subscriptionIds: definitelyRejectedSubscriptionIds,
  });
  return results.some((result) => result.ok || result.statusCode === undefined)
    ? { record: params.record, sender: sendWebPushNotifications }
    : null;
}

/** Retains successful request targets so terminal state replaces their tagged alert. */
export function createApprovalWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
}) {
  const deliveriesByApprovalId = new Map<string, Promise<ApprovalRequestWebPushDelivery | null>>();
  const terminalDeliveriesByApprovalId = new Map<string, Promise<void>>();

  const handleTerminal = (approval: { id: string }): Promise<void> =>
    getOrCreatePromise(
      terminalDeliveriesByApprovalId,
      approval.id,
      async () => {
        const requestPush = deliveriesByApprovalId.get(approval.id);
        deliveriesByApprovalId.delete(approval.id);
        const requestDelivery = requestPush ? await requestPush : null;
        const sender = requestDelivery?.sender ?? (await prepareWebPushNotificationSender());
        const durableLookup = requestDelivery
          ? null
          : await getOperatorApprovalDetailed({
              id: approval.id,
            });
        const durableRecord = durableLookup?.outcome === "found" ? durableLookup.record : null;
        const subscriptions = await listWebPushApprovalDeliveryTargets({
          approvalId: approval.id,
        });
        if (subscriptions.length === 0) {
          return;
        }
        const suppressedSubscriptionIds: string[] = [];
        const source =
          requestDelivery && isRecord(requestDelivery.record.request)
            ? requestDelivery.record.request
            : durableRecord?.source;
        const sessionKey = normalizeOptionalString(source?.sessionKey);
        const agentId = normalizeOptionalString(source?.agentId);
        const intent = approvalNotificationIntent({
          approvalId: approval.id,
          terminal: true,
          ...(agentId ? { agentId } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          canReceive: ({ cfg, client, sessionAccess }) =>
            requestDelivery
              ? isApprovalRecordVisibleToClient({
                  record: requestDelivery.record,
                  client,
                  cfg,
                  prepared: sessionAccess(),
                })
              : Boolean(
                  durableRecord &&
                  canAccessOperatorApproval({
                    client,
                    binding: { reviewerDeviceIds: durableRecord.reviewerDeviceIds },
                  }) &&
                  canAccessApprovalSession({
                    cfg,
                    client,
                    ...readOperatorApprovalRequestSource(durableRecord),
                    prepared: sessionAccess(),
                  }),
                ),
        });
        const preparedIcon = await prepareWebPushAgentIcon(params.getRuntimeConfig(), agentId);
        const groupedResults = await withCurrentWebPushAuthority(
          {
            ...params,
            sessionKeys: intent.sessionKeys,
            agentId,
          },
          (authority) => {
            const { cfg } = authority;
            const currentTargets = listCurrentWebPushTargets({
              ...authority,
              requiredScopes: intent.requiredScopes,
            });
            const currentTargetsBySubscriptionId = new Map(
              currentTargets.map((target) => [target.subscription.subscriptionId, target]),
            );
            const terminalGroups = new Map<string, ApprovalNotificationGroup>();
            for (const subscription of subscriptions) {
              const current = currentTargetsBySubscriptionId.get(subscription.subscriptionId);
              const target =
                current?.subscription.deviceId === subscription.deviceId &&
                current.subscription.userProfileId === subscription.userProfileId
                  ? current
                  : undefined;
              if (
                !target ||
                !canNotificationRecipientReceive(intent, authority, webPushTargetClient(target))
              ) {
                suppressedSubscriptionIds.push(subscription.subscriptionId);
                continue;
              }
              const copy = approvalNotificationCopy({
                intent,
                preferences: target.preferences,
                icon: currentWebPushAgentIcon(cfg, preparedIcon),
              });
              const key = JSON.stringify(copy);
              const group = terminalGroups.get(key) ?? { copy, subscriptions: [] };
              group.subscriptions.push(target.subscription);
              terminalGroups.set(key, group);
            }
            return {
              start: () =>
                sendApprovalNotificationGroups({
                  sender,
                  cfg,
                  approvalId: approval.id,
                  intent,
                  ttlSeconds: WEB_PUSH_TERMINAL_TTL_SECONDS,
                  groups: terminalGroups.values(),
                }),
            };
          },
        );
        if (!groupedResults) {
          return;
        }
        const results = groupedResults.flat();
        const successfulSubscriptionIds = results
          .filter((result) => result.ok)
          .map((result) => result.subscriptionId);
        await deleteWebPushApprovalDeliveryTargets({
          approvalId: approval.id,
          subscriptionIds: [...successfulSubscriptionIds, ...suppressedSubscriptionIds],
        });
        const completedSubscriptionCount =
          successfulSubscriptionIds.length + suppressedSubscriptionIds.length;
        if (completedSubscriptionCount < subscriptions.length) {
          params.log?.warn?.(
            `approval Web Push terminal replacement reached ${successfulSubscriptionIds.length}/${subscriptions.length - suppressedSubscriptionIds.length} eligible browsers approvalId=${approval.id}`,
          );
        }
      },
      { evictOnSettled: true },
    );

  return {
    /** Sends a request notification only when at least one browser has a durable binding. */
    handleRequested<TPayload>(record: ExecApprovalRecord<TPayload>): Promise<boolean> {
      const requestPush = deliverBoundApprovalWebPush({
        record,
        getRuntimeConfig: params.getRuntimeConfig,
      });
      deliveriesByApprovalId.set(record.id, requestPush);
      return requestPush.then(
        (delivery) => {
          if (!delivery && deliveriesByApprovalId.get(record.id) === requestPush) {
            deliveriesByApprovalId.delete(record.id);
          }
          return Boolean(delivery);
        },
        (error: unknown) => {
          if (deliveriesByApprovalId.get(record.id) === requestPush) {
            deliveriesByApprovalId.delete(record.id);
          }
          throw error;
        },
      );
    },

    handleResolved: handleTerminal,
    handleExpired: handleTerminal,
    async recoverTerminalDeliveries(): Promise<void> {
      let afterApprovalId: string | undefined;
      let throughApprovalId: string | undefined;
      do {
        const page = await listTerminalWebPushApprovalDeliveryIds({
          ...(afterApprovalId ? { afterApprovalId } : {}),
          ...(throughApprovalId ? { throughApprovalId } : {}),
        });
        throughApprovalId = page.throughApprovalId ?? undefined;
        for (const approvalId of page.approvalIds) {
          await handleTerminal({ id: approvalId });
        }
        afterApprovalId = page.nextAfterApprovalId ?? undefined;
      } while (afterApprovalId);
    },
  };
}
