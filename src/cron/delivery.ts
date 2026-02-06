import type { CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  mode: CronDeliveryMode;
  channel: CronMessageChannel;
  to?: string;
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

export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  const payload = job.payload.kind === "agentTurn" ? job.payload : null;
  const delivery = job.delivery;
  const hasDelivery = delivery && typeof delivery === "object";
  const rawMode = hasDelivery ? (delivery as { mode?: unknown }).mode : undefined;
  const mode =
    rawMode === "announce"
      ? "announce"
      : rawMode === "none"
        ? "none"
        : rawMode === "deliver"
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
  if (hasDelivery) {
    const resolvedMode = mode ?? "none";
    return {
      mode: resolvedMode,
      channel,
      to,
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
