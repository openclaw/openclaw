import { randomUUID } from "node:crypto";
import {
  resolveTimerTimeoutMs,
  addTimerTimeoutGraceMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";

export function resolvePendingSystemRunEvent(params: {
  command: string;
  params?: unknown;
  turnSource?: DeliveryContext;
}): PendingSystemRunEvent | undefined {
  const obj = asOptionalObjectRecord(params.params);
  if (params.command !== "system.run" || !obj) {
    return undefined;
  }
  const runId = normalizeOptionalString(obj.runId) ?? "";
  if (!runId) {
    return undefined;
  }
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  const source = params.turnSource;
  const channel = normalizeMessageChannel(source?.channel);
  const to = normalizeOptionalString(source?.to);
  // Never recover this from node-selected hints or mutable last-delivery history.
  const invocationDeliveryContext =
    channel === "telegram" && to && sessionKey
      ? {
          channel,
          to,
          accountId: source?.accountId ?? DEFAULT_ACCOUNT_ID,
          ...(source?.threadId != null ? { threadId: source.threadId } : {}),
        }
      : undefined;
  return {
    runId,
    ...(invocationDeliveryContext ? { invocationDeliveryContext } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function normalizeSystemRunInvokeParams(params: {
  command: string;
  params?: unknown;
}): unknown {
  if (params.command !== "system.run" || !isRecord(params.params)) {
    return params.params;
  }
  const obj = params.params;
  const normalized: Record<string, unknown> = {
    ...obj,
    runId: normalizeOptionalString(obj.runId) || randomUUID(),
  };
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  if (timeoutMs === undefined) {
    delete normalized.timeoutMs;
  } else {
    normalized.timeoutMs = timeoutMs;
  }
  return normalized;
}

/** Normalize system.run timeout values, preserving null for no expiry. */
function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : null;
}

export function authorizedSystemRunEventExpiresAt(
  timeoutMs: number | null | undefined,
): number | null {
  if (typeof timeoutMs !== "number") {
    return null;
  }
  const durationMs = addTimerTimeoutGraceMs(timeoutMs, AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS);
  return resolveExpiresAtMsFromDurationMs(durationMs) ?? 0;
}

export function authorizedSystemRunEventKey(params: {
  nodeId: string;
  connId: string;
  runId: string;
  sessionKey?: string;
}): string {
  return `${params.nodeId}\0${params.connId}\0${params.sessionKey ?? ""}\0${params.runId}`;
}

const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;
