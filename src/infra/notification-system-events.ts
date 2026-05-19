import type {
  NotificationEventFamily,
  NotificationWakePolicy,
  NotificationWakePolicyConfig,
  NotificationWakePolicySetting,
} from "../config/types.notifications.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { requestHeartbeat } from "./heartbeat-wake.js";
import { enqueueSystemEvent } from "./system-events.js";

type EnqueueSystemEvent = typeof enqueueSystemEvent;
const NOTIFICATION_WAKE_REASON_PREFIX = "notification-wake:";

type WakeConfigRecord = {
  notificationWake?: NotificationWakePolicyConfig;
};

type ChannelConfigRecord = WakeConfigRecord & {
  accounts?: Record<string, unknown>;
};

type NotificationWakeConfigRoot = {
  agents?: {
    defaults?: WakeConfigRecord;
    list?: Array<{ id?: string } & WakeConfigRecord>;
  };
  channels?: {
    defaults?: WakeConfigRecord;
    [channel: string]: unknown;
  };
  notifications?: {
    systemEvents?: NotificationWakePolicyConfig;
  };
};

export type EnqueueNotificationSystemEventOptions = {
  cfg?: unknown;
  channel: string;
  accountId?: string;
  agentId?: string;
  sessionKey: string;
  family: NotificationEventFamily;
  text: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  forceSenderIsOwnerFalse?: boolean;
  /** @deprecated Use forceSenderIsOwnerFalse. Kept for installed plugin compatibility. */
  trusted?: boolean;
  reason?: string;
  defaultPolicy?: NotificationWakePolicy;
  enqueueSystemEvent?: EnqueueSystemEvent;
};

export type EnqueueNotificationSystemEventResult =
  | {
      status: "skipped";
      policy: "off";
      enqueued: false;
      woke: false;
    }
  | {
      status: "deduped";
      policy: Exclude<NotificationWakePolicy, "off">;
      enqueued: false;
      woke: false;
    }
  | {
      status: "enqueued";
      policy: Exclude<NotificationWakePolicy, "off">;
      enqueued: true;
      woke: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNotificationWakeConfig(value: unknown): NotificationWakePolicyConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as NotificationWakePolicyConfig;
}

function asConfigRoot(value: unknown): NotificationWakeConfigRoot | undefined {
  return isRecord(value) ? (value as NotificationWakeConfigRoot) : undefined;
}

function resolvePolicySetting(
  config: NotificationWakePolicyConfig | undefined,
  family: NotificationEventFamily,
): NotificationWakePolicySetting | undefined {
  return config?.[family];
}

function resolvePolicyFromList(
  family: NotificationEventFamily,
  configs: Array<NotificationWakePolicyConfig | undefined>,
): NotificationWakePolicy | undefined {
  for (const config of configs) {
    const setting = resolvePolicySetting(config, family);
    if (setting && setting !== "inherit") {
      return setting;
    }
  }
  return undefined;
}

function resolveChannelConfig(
  cfg: NotificationWakeConfigRoot | undefined,
  channel: string,
): ChannelConfigRecord | undefined {
  const entry = cfg?.channels?.[channel];
  return isRecord(entry) ? (entry as ChannelConfigRecord) : undefined;
}

function resolveAccountNotificationWake(
  channelConfig: ChannelConfigRecord | undefined,
  accountId: string | undefined,
): NotificationWakePolicyConfig | undefined {
  if (!channelConfig?.accounts || !accountId) {
    return undefined;
  }
  const account = resolveNormalizedAccountEntry(
    channelConfig.accounts,
    accountId,
    normalizeAccountId,
  );
  return isRecord(account) ? asNotificationWakeConfig(account.notificationWake) : undefined;
}

function resolveAgentNotificationWake(
  cfg: NotificationWakeConfigRoot | undefined,
  agentId: string | undefined,
): NotificationWakePolicyConfig | undefined {
  if (!agentId) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  return cfg?.agents?.list?.find((agent) => normalizeAgentId(agent.id) === normalizedAgentId)
    ?.notificationWake;
}

export function resolveNotificationWakePolicy(params: {
  cfg?: unknown;
  channel: string;
  accountId?: string;
  agentId?: string;
  family: NotificationEventFamily;
  defaultPolicy?: NotificationWakePolicy;
}): NotificationWakePolicy {
  const cfg = asConfigRoot(params.cfg);
  const channelConfig = resolveChannelConfig(cfg, params.channel);
  return (
    resolvePolicyFromList(params.family, [
      resolveAccountNotificationWake(channelConfig, params.accountId),
      channelConfig?.notificationWake,
      resolveAgentNotificationWake(cfg, params.agentId),
      cfg?.agents?.defaults?.notificationWake,
      cfg?.channels?.defaults?.notificationWake,
      cfg?.notifications?.systemEvents,
    ]) ??
    params.defaultPolicy ??
    "queue"
  );
}

export function enqueueNotificationSystemEvent(
  options: EnqueueNotificationSystemEventOptions,
): EnqueueNotificationSystemEventResult {
  const policy = resolveNotificationWakePolicy(options);
  if (policy === "off") {
    return { status: "skipped", policy, enqueued: false, woke: false };
  }

  const enqueue = options.enqueueSystemEvent ?? enqueueSystemEvent;
  const enqueued = enqueue(options.text, {
    sessionKey: options.sessionKey,
    contextKey: options.contextKey,
    deliveryContext: options.deliveryContext,
    forceSenderIsOwnerFalse: options.forceSenderIsOwnerFalse,
    trusted: options.trusted,
  });
  if (!enqueued) {
    return { status: "deduped", policy, enqueued: false, woke: false };
  }

  const woke = policy === "wake";
  if (woke) {
    const reasonDetail = (options.reason ?? `${options.channel}:${options.family}`).trim();
    requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: `${NOTIFICATION_WAKE_REASON_PREFIX}${reasonDetail || `${options.channel}:${options.family}`}`,
      agentId: options.agentId,
      sessionKey: options.sessionKey,
    });
  }

  return { status: "enqueued", policy, enqueued: true, woke };
}
