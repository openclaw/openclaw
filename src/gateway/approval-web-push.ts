// Delivers generic approval notifications to Web Push subscriptions whose
// persisted browser binding still has current approval and visibility access.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
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
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { canAccessOperatorApproval } from "./operator-approval-authorization.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { READ_SCOPE } from "./operator-scopes.js";
import {
  canAccessApprovalSession,
  isApprovalRecordVisibleToClient,
} from "./server-methods/approval-record-lookup.js";
import {
  listCurrentWebPushTargets,
  webPushTargetClient,
  webPushSessionAccess,
  withCurrentWebPushAuthority,
  type CurrentWebPushTarget,
  type WebPushAuthority,
} from "./web-push-authority.js";

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
  terminal: boolean;
  preferences: CurrentWebPushTarget["preferences"];
  agentLabel?: string;
}) {
  const label = params.preferences.label ? `${params.preferences.label} · ` : "";
  const agent = params.agentLabel ? ` for ${params.agentLabel}` : "";
  if (params.terminal) {
    return {
      title: `${label}OpenClaw approval updated`,
      body:
        params.preferences.detailLevel === "private"
          ? "This approval is no longer pending."
          : `Approval${agent} is no longer pending.`,
    };
  }
  return {
    title: `${label}OpenClaw approval requested`,
    body:
      params.preferences.detailLevel === "private"
        ? "Open OpenClaw to review this request."
        : `Open OpenClaw to review an approval${agent}.`,
  };
}

type ApprovalWebPushDeliveryState = {
  requestPushPromise: Promise<ApprovalRequestWebPushDelivery | null>;
};

function approvalWebPushTag(approvalId: string): string {
  return `openclaw-approval-${approvalId}`;
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
          tag: approvalWebPushTag(params.approvalId),
          url: resolveControlUiWebPushUrl(
            params.cfg,
            `approve/${encodeURIComponent(params.approvalId)}`,
          ),
        },
        deliveryOptions: {
          TTL: params.ttlSeconds,
          urgency: "high",
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
  stateDir?: string;
}): Promise<ApprovalRequestWebPushDelivery | null> {
  if (params.record.resolvedAtMs !== undefined || params.record.expiresAtMs <= Date.now()) {
    return null;
  }
  if (!(await hasBoundWebPushSubscriptions(params.stateDir))) {
    return null;
  }
  const sendWebPushNotifications = await prepareWebPushNotificationSender(params.stateDir);
  const source = isRecord(params.record.request) ? params.record.request : undefined;
  const agentId = normalizeOptionalString(source?.agentId);
  const sessionKey = normalizeOptionalString(source?.sessionKey);
  const preparation = { ...params, agentId, sessionKeys: sessionKey ? [sessionKey] : [] };
  const eligibleTargets = (authority: WebPushAuthority) =>
    listCurrentWebPushTargets({
      ...authority,
      requiredScopes: [APPROVALS_SCOPE, READ_SCOPE],
    }).filter((target) => {
      const { preferences } = target;
      const client = webPushTargetClient(target);
      return (
        webPushCategoryEnabled(preferences, "approval-requested") &&
        !isWebPushQuietHours(preferences) &&
        webPushAgentAllowed(preferences, agentId) &&
        isApprovalRecordVisibleToClient({
          record: params.record,
          client,
          cfg: authority.cfg,
          prepared: webPushSessionAccess(authority, client),
        })
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
      stateDir: params.stateDir,
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
    const agentLabel = normalizeWebPushDisplayLabel(agentId);
    const requestGroups = new Map<string, ApprovalNotificationGroup>();
    for (const { subscription, preferences } of currentEligibleTargets) {
      const copy = approvalNotificationCopy({ terminal: false, preferences, agentLabel });
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
    stateDir: params.stateDir,
  });
  const possibleDeliverySubscriptionIds = new Set(
    results
      .filter((result) => result.ok || result.statusCode === undefined)
      .map((result) => result.subscriptionId),
  );
  return possibleDeliverySubscriptionIds.size > 0
    ? { record: params.record, sender: sendWebPushNotifications }
    : null;
}

/** Retains successful request targets so terminal state replaces their tagged alert. */
export function createApprovalWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
  stateDir?: string;
}) {
  const deliveriesByApprovalId = new Map<string, ApprovalWebPushDeliveryState>();
  const terminalDeliveriesByApprovalId = new Map<string, Promise<void>>();

  const handleTerminal = (approval: { id: string }): Promise<void> => {
    const active = terminalDeliveriesByApprovalId.get(approval.id);
    if (active) {
      return active;
    }
    const terminalDelivery = (async () => {
      const deliveryState = deliveriesByApprovalId.get(approval.id);
      deliveriesByApprovalId.delete(approval.id);
      const requestDelivery = deliveryState ? await deliveryState.requestPushPromise : null;
      const sender =
        requestDelivery?.sender ?? (await prepareWebPushNotificationSender(params.stateDir));
      const durableLookup = requestDelivery
        ? null
        : await getOperatorApprovalDetailed({
            id: approval.id,
            databaseOptions: params.stateDir
              ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
              : undefined,
          });
      const durableRecord = durableLookup?.outcome === "found" ? durableLookup.record : null;
      const recordedSubscriptions = await listWebPushApprovalDeliveryTargets({
        approvalId: approval.id,
        stateDir: params.stateDir,
      });
      if (recordedSubscriptions.length === 0) {
        return;
      }
      const subscriptions = recordedSubscriptions;
      const suppressedSubscriptionIds: string[] = [];
      const source =
        requestDelivery && isRecord(requestDelivery.record.request)
          ? requestDelivery.record.request
          : durableRecord?.source;
      const sessionKey = normalizeOptionalString(source?.sessionKey);
      const groupedResults = await withCurrentWebPushAuthority(
        {
          ...params,
          sessionKeys: sessionKey ? [sessionKey] : [],
          agentId: normalizeOptionalString(source?.agentId),
        },
        (authority) => {
          const { cfg } = authority;
          const currentTargets = listCurrentWebPushTargets({
            ...authority,
            requiredScopes: [APPROVALS_SCOPE, READ_SCOPE],
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
            const client = target ? webPushTargetClient(target) : null;
            const visible = requestDelivery
              ? Boolean(
                  client &&
                  isApprovalRecordVisibleToClient({
                    record: requestDelivery.record,
                    client,
                    cfg,
                    prepared: webPushSessionAccess(authority, client),
                  }),
                )
              : Boolean(
                  client &&
                  durableRecord &&
                  canAccessOperatorApproval({
                    client,
                    binding: { reviewerDeviceIds: durableRecord.reviewerDeviceIds },
                  }) &&
                  canAccessApprovalSession({
                    cfg,
                    client,
                    sessionKey: durableRecord.source.sessionKey,
                    agentId: durableRecord.source.agentId,
                    prepared: webPushSessionAccess(authority, client),
                  }),
                );
            if (!target || !visible) {
              suppressedSubscriptionIds.push(subscription.subscriptionId);
              continue;
            }
            const copy = approvalNotificationCopy({
              terminal: true,
              preferences: target.preferences,
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
        stateDir: params.stateDir,
      });
      const completedSubscriptionCount =
        successfulSubscriptionIds.length + suppressedSubscriptionIds.length;
      if (completedSubscriptionCount < subscriptions.length) {
        params.log?.warn?.(
          `approval Web Push terminal replacement reached ${successfulSubscriptionIds.length}/${subscriptions.length - suppressedSubscriptionIds.length} eligible browsers approvalId=${approval.id}`,
        );
      }
    })();
    terminalDeliveriesByApprovalId.set(approval.id, terminalDelivery);
    const releaseTerminalDelivery = () => {
      if (terminalDeliveriesByApprovalId.get(approval.id) === terminalDelivery) {
        terminalDeliveriesByApprovalId.delete(approval.id);
      }
    };
    void terminalDelivery.then(releaseTerminalDelivery, releaseTerminalDelivery);
    return terminalDelivery;
  };

  return {
    /** Sends a request notification only when at least one browser has a durable binding. */
    handleRequested<TPayload>(record: ExecApprovalRecord<TPayload>): Promise<boolean> {
      const deliveryState: ApprovalWebPushDeliveryState = {
        requestPushPromise: deliverBoundApprovalWebPush({
          record,
          getRuntimeConfig: params.getRuntimeConfig,
          stateDir: params.stateDir,
        }),
      };
      deliveriesByApprovalId.set(record.id, deliveryState);
      return deliveryState.requestPushPromise.then(
        (delivery) => {
          if (!delivery && deliveriesByApprovalId.get(record.id) === deliveryState) {
            deliveriesByApprovalId.delete(record.id);
          }
          return Boolean(delivery);
        },
        (error: unknown) => {
          if (deliveriesByApprovalId.get(record.id) === deliveryState) {
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
          stateDir: params.stateDir,
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
