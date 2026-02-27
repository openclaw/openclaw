import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit channel account id from the delivery config, if set. */
  accountId?: string;
  source: "delivery" | "payload";
  requested: boolean;
};

function normalizeChannel(value: unknown): CronMessageChannel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed as CronMessageChannel;
}

function normalizeTo(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  const payload = job.payload.kind === "agentTurn" ? job.payload : null;
  const delivery = job.delivery;
  const hasDelivery = delivery && typeof delivery === "object";
  const rawMode = hasDelivery ? (delivery as { mode?: unknown }).mode : undefined;
  const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : rawMode;
  const mode =
    normalizedMode === "announce"
      ? "announce"
      : normalizedMode === "webhook"
        ? "webhook"
        : normalizedMode === "none"
          ? "none"
          : normalizedMode === "deliver"
            ? "announce"
            : undefined;

  const payloadChannel = normalizeChannel(payload?.channel);
  const payloadTo = normalizeTo(payload?.to);
  const deliveryChannel = normalizeChannel(
    (delivery as { channel?: unknown } | undefined)?.channel,
  );
  const deliveryTo = normalizeTo((delivery as { to?: unknown } | undefined)?.to);
  const channel = deliveryChannel ?? payloadChannel ?? "last";
  const to = deliveryTo ?? payloadTo;
  const deliveryAccountId = normalizeAccountId(
    (delivery as { accountId?: unknown } | undefined)?.accountId,
  );
  if (hasDelivery) {
    const resolvedMode = mode ?? "announce";
    return {
      mode: resolvedMode,
      channel: resolvedMode === "announce" ? channel : undefined,
      to,
      accountId: deliveryAccountId,
      source: "delivery",
      requested: resolvedMode === "announce",
    };
  }

  const legacyMode =
    payload?.deliver === true ? "explicit" : payload?.deliver === false ? "off" : "auto";
  const hasExplicitTarget = Boolean(to);
  const requested = legacyMode === "explicit" || (legacyMode === "auto" && hasExplicitTarget);

  return {
    mode: requested ? "announce" : "none",
    channel,
    to,
    source: "payload",
    requested,
  };
}

export type CronFailureDeliveryPlan = {
  mode: "announce" | "webhook";
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
};

function normalizeFailureMode(value: unknown): "announce" | "webhook" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "announce" || trimmed === "webhook") {
    return trimmed;
  }
  return undefined;
}

export function resolveFailureDestination(
  job: CronJob,
  globalConfig?: CronFailureDestinationConfig,
): CronFailureDeliveryPlan | null {
  const delivery = job.delivery;
  const jobFailureDest = delivery?.failureDestination;
  const hasJobFailureDest = jobFailureDest && typeof jobFailureDest === "object";

  let channel: CronMessageChannel | undefined;
  let to: string | undefined;
  let accountId: string | undefined;
  let mode: "announce" | "webhook" | undefined;

  if (hasJobFailureDest) {
    channel = normalizeChannel((jobFailureDest as { channel?: unknown }).channel);
    to = normalizeTo((jobFailureDest as { to?: unknown }).to);
    accountId = normalizeAccountId((jobFailureDest as { accountId?: unknown }).accountId);
    mode = normalizeFailureMode((jobFailureDest as { mode?: unknown }).mode);
  } else if (globalConfig) {
    channel = normalizeChannel(globalConfig.channel);
    to = normalizeTo(globalConfig.to);
    accountId = normalizeAccountId(globalConfig.accountId);
    mode = normalizeFailureMode(globalConfig.mode);
  }

  if (!channel && !to && !mode) {
    return null;
  }

  const resolvedMode = mode ?? "announce";
  return {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? (channel ?? "last") : undefined,
    to,
    accountId,
  };
}
