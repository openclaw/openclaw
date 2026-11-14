import { randomUUID } from "node:crypto";
import {
  resolveTimerTimeoutMs,
  addTimerTimeoutGraceMs,
  resolveExpiresAtMsFromDurationMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import type { PendingInvoke, PendingSystemRunEvent } from "./node-registry.invoke-stream.js";
import type { NodeSession } from "./node-session.types.js";

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

function authorizedSystemRunEventExpiresAt(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== "number") {
    return null;
  }
  const durationMs = addTimerTimeoutGraceMs(timeoutMs, AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS);
  return resolveExpiresAtMsFromDurationMs(durationMs) ?? 0;
}

function authorizedSystemRunEventKey(params: {
  nodeId: string;
  connId: string;
  runId: string;
  sessionKey?: string;
}): string {
  return `${params.nodeId}\0${params.connId}\0${params.sessionKey ?? ""}\0${params.runId}`;
}

const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;

type AuthorizedSystemRunEvent = PendingSystemRunEvent & {
  nodeId: string;
  connId: string;
  expiresAtMs: number | null;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

/** Owns delayed notices independently of the inline invocation's request lifetime. */
export class NodeSystemRunEvents {
  private authorizedSystemRunEvents = new Map<string, AuthorizedSystemRunEvent>();

  constructor(
    private readonly pendingInvokes: Map<string, PendingInvoke>,
    private readonly getNode: (nodeId: string) => NodeSession | undefined,
  ) {}
  authorize(params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
  }):
    | (Pick<PendingSystemRunEvent, "invocationDeliveryContext"> & {
        expectedTarget?: SessionEventTarget;
        release?: () => void;
        holdNotice?: (notify: () => void) => void;
      })
    | null {
    if (!params.connId || !params.sessionKey) {
      return null;
    }
    const connId = params.connId;
    this.pruneAuthorizedSystemRunEvents();
    let match = params.runId
      ? this.matchAuthorizedSystemRunEvent({
          nodeId: params.nodeId,
          connId,
          runId: params.runId,
          sessionKey: params.sessionKey,
        })
      : null;
    if (match === null && this.allowsLegacyMacRunIdFallback({ nodeId: params.nodeId, connId })) {
      match = this.matchAuthorizedSystemRunEvent({
        nodeId: params.nodeId,
        connId,
        sessionKey: params.sessionKey,
      });
    }
    if (match === null) {
      return null;
    }
    const event = this.authorizedSystemRunEvents.get(match);
    const source = event?.invocationDeliveryContext;
    let waiting: PendingInvoke | undefined;
    if (params.terminal) {
      this.authorizedSystemRunEvents.delete(match);
      clearTimeout(event?.expiryTimer);
      // The node reports completion before its result; a still-waiting caller receives that output.
      waiting = [...this.pendingInvokes.values()].find(
        (pending) =>
          pending.nodeId === params.nodeId &&
          pending.connId === connId &&
          pending.systemRunEvent?.runId === event?.runId,
      );
    }
    return {
      ...(source ? { invocationDeliveryContext: { ...source } } : {}),
      ...(event?.source
        ? {
            expectedTarget: event.source.expectedTarget,
            ...(params.terminal ? { release: event.source.release } : {}),
          }
        : {}),
      ...(waiting
        ? {
            holdNotice: (notify: () => void) => {
              const resolve = waiting.resolve;
              waiting.resolve = (value) => {
                resolve(value);
                if (!value.ok) {
                  notify();
                } else {
                  event?.source?.release();
                }
              };
            },
          }
        : {}),
    };
  }

  remember(event: Omit<AuthorizedSystemRunEvent, "expiresAtMs">): void {
    this.pruneAuthorizedSystemRunEvents();
    const authorized: AuthorizedSystemRunEvent = {
      ...event,
      expiresAtMs: authorizedSystemRunEventExpiresAt(event.timeoutMs),
    };
    if (authorized.source && authorized.expiresAtMs !== null) {
      authorized.expiryTimer = setTimeout(
        () => this.forget(authorized),
        Math.max(0, authorized.expiresAtMs - Date.now()),
      );
      authorized.expiryTimer.unref();
    }
    this.forget(authorized);
    this.authorizedSystemRunEvents.set(authorizedSystemRunEventKey(authorized), authorized);
  }

  forget(event: Omit<AuthorizedSystemRunEvent, "expiresAtMs">): void {
    const key = authorizedSystemRunEventKey(event);
    const previous = this.authorizedSystemRunEvents.get(key);
    this.authorizedSystemRunEvents.delete(key);
    clearTimeout(previous?.expiryTimer);
    previous?.source?.release();
  }

  disconnect(connId: string): void {
    for (const event of this.authorizedSystemRunEvents.values()) {
      if (event.connId === connId) {
        this.forget(event);
      }
    }
  }

  private matchAuthorizedSystemRunEvent(params: {
    nodeId: string;
    connId: string;
    runId?: string;
    sessionKey: string;
  }): string | null {
    let match: string | null = null;
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (
        event.nodeId !== params.nodeId ||
        event.connId !== params.connId ||
        (params.runId !== undefined && event.runId !== params.runId) ||
        (event.sessionKey && event.sessionKey !== params.sessionKey)
      ) {
        continue;
      }
      if (params.runId !== undefined) {
        return key;
      }
      // Legacy macOS events may omit the run ID, but only one pending run may match.
      if (match !== null) {
        return null;
      }
      match = key;
    }
    return match;
  }

  private allowsLegacyMacRunIdFallback(params: { nodeId: string; connId: string }): boolean {
    const node = this.getNode(params.nodeId);
    return (
      node?.connId === params.connId &&
      node.clientId === "openclaw-macos" &&
      node.platform === "darwin"
    );
  }

  private pruneAuthorizedSystemRunEvents(now = Date.now()): void {
    for (const event of this.authorizedSystemRunEvents.values()) {
      if (
        event.expiresAtMs !== null &&
        !isFutureDateTimestampMs(event.expiresAtMs, { nowMs: now })
      ) {
        this.forget(event);
      }
    }
  }
}
