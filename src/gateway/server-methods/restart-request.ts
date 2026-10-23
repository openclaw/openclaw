import {
  asSafeIntegerInRange,
  MAX_TIMER_TIMEOUT_MS,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";

type RestartDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

// Restart sentinels can resume a channel turn after the gateway comes back.
// Keep only routable delivery fields plus a normalized thread id so malformed
// UI/tool payloads do not leak arbitrary data into the sentinel file.
export function parseRestartRequestParams(params: unknown): {
  sessionKey: string | undefined;
  deliveryContext: RestartDeliveryContext | undefined;
  threadId: string | undefined;
  note: string | undefined;
  continuationMessage: string | undefined;
  restartDelayMs: number | undefined;
} {
  const raw = params as Record<string, unknown>;
  const sessionKey = normalizeOptionalString(raw.sessionKey);
  const context = asOptionalRecord(raw.deliveryContext);
  const normalizedContext = context
    ? {
        channel: normalizeOptionalString(context.channel),
        to: normalizeOptionalString(context.to),
        accountId: normalizeOptionalString(context.accountId),
      }
    : undefined;
  const deliveryContext =
    normalizedContext?.channel || normalizedContext?.to || normalizedContext?.accountId
      ? normalizedContext
      : undefined;
  const threadId = context ? stringifyRouteThreadId(context.threadId) : undefined;
  const note = normalizeOptionalString(raw.note);
  const continuationMessage = normalizeOptionalString(raw.continuationMessage);
  const restartDelayMs = resolveOptionalIntegerOption(raw.restartDelayMs, { min: 0 });
  return { sessionKey, deliveryContext, threadId, note, continuationMessage, restartDelayMs };
}

type TargetedGatewayRestart = {
  pid: number;
  ownerId: string;
  port: number;
};

export function parseTargetedGatewayRestart(
  target: unknown,
): TargetedGatewayRestart | null | undefined {
  if (target === undefined) {
    return undefined;
  }
  if (!isRecord(target)) {
    return null;
  }
  const pid = asSafeIntegerInRange(target.pid, { min: 1 });
  const ownerId = normalizeOptionalString(target.ownerId);
  const port = asSafeIntegerInRange(target.port, { min: 1, max: 65_535 });
  return pid !== undefined && ownerId && port !== undefined ? { pid, ownerId, port } : null;
}

export function parseTargetedGatewayRestartIntent(
  value: unknown,
  reason: string | undefined,
): GatewayRestartIntent | null {
  if (value !== undefined && !isRecord(value)) {
    return null;
  }
  const raw = value ?? {};
  const force = raw.force === true;
  // Older Gateways ignore this optional field instead of rejecting force + waitMs.
  const budget = force ? raw.drainBudgetMs : raw.waitMs;
  const waitMs = asSafeIntegerInRange(budget, { min: 0, max: MAX_TIMER_TIMEOUT_MS });
  if (
    (raw.force !== undefined && typeof raw.force !== "boolean") ||
    (budget !== undefined && waitMs === undefined) ||
    (force && raw.waitMs !== undefined) ||
    (!force && raw.drainBudgetMs !== undefined)
  ) {
    return null;
  }
  return {
    ...(reason ? { reason } : {}),
    ...(force ? { force: true } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

/**
 * Only the predecessor-bound restart may cross a prepared suspension lease.
 * The live lock target is sufficient: restart drain becomes the stronger owner
 * and explicitly retires the reversible suspension token after delivery.
 */
export function isTargetedNonSafeGatewayRestartRequest(params: unknown): boolean {
  if (!isRecord(params) || (params.safe !== undefined && params.safe !== false)) {
    return false;
  }
  const target = parseTargetedGatewayRestart(params.target);
  return (
    target !== undefined &&
    target !== null &&
    parseTargetedGatewayRestartIntent(params.restartIntent, undefined) !== null
  );
}
