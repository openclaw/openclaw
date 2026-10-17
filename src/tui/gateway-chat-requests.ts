import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import type { GatewayClient } from "../gateway/client.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { sleep } from "../utils/sleep.js";
import type { TuiRequestScope } from "./tui-backend.js";

const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;

function isRetryableStartupUnavailable(
  err: unknown,
  method: string,
): err is GatewayClientRequestError {
  if (!(err instanceof GatewayClientRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = "method" in details ? details.method : undefined;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayClientRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

export function isLegacyParameterError(err: unknown, method: string, parameter: string): boolean {
  if (!(err instanceof GatewayClientRequestError) || err.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes(`invalid ${method} params`) && message.includes(parameter);
}

/** Owns interactive request cancellation and startup admission lifetimes. */
export class GatewayChatRequests {
  private readonly lifetime = new AbortController();
  private readonly pendingWrites = new Set<TuiRequestScope & { controller: AbortController }>();
  readonly signal = this.lifetime.signal;

  constructor(private readonly client: Pick<GatewayClient, "request">) {}

  stop(): void {
    this.lifetime.abort();
    for (const pending of this.pendingWrites) {
      pending.controller.abort();
    }
  }

  cancelPending(scope: TuiRequestScope): boolean {
    const agentId = scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId;
    let cancelled = false;
    for (const pending of this.pendingWrites) {
      if (
        pending.sessionKey === scope.sessionKey &&
        pending.agentId === agentId &&
        (!scope.runId || pending.runId === scope.runId)
      ) {
        pending.controller.abort();
        cancelled = true;
      }
    }
    return cancelled;
  }

  async write<T>(method: string, params: unknown, scope: TuiRequestScope): Promise<T> {
    const pending = {
      ...scope,
      agentId: scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId,
      controller: new AbortController(),
    };
    this.pendingWrites.add(pending);
    try {
      return await this.client.request<T>(method, params, {
        timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
        signal: pending.controller.signal,
      });
    } finally {
      this.pendingWrites.delete(pending);
    }
  }

  async abortChat(opts: TuiRequestScope) {
    const cancelled = this.cancelPending(opts);
    const params = {
      sessionKey: opts.sessionKey,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
    };
    try {
      const result = await this.client.request<{
        ok: boolean;
        aborted: boolean;
        runIds?: string[];
      }>("chat.abort", opts.runId ? params : { ...params, preserveSideRuns: true });
      return { ...result, aborted: result.aborted || cancelled };
    } catch (err) {
      // Protocol v4 peers reject unknown fields. Keep their shipped abort shape.
      if (opts.runId || !isLegacyParameterError(err, "chat.abort", "preservesideruns")) {
        throw err;
      }
      const result = await this.client.request<{
        ok: boolean;
        aborted: boolean;
        runIds?: string[];
      }>("chat.abort", params);
      return { ...result, aborted: result.aborted || cancelled };
    }
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }) {
    const deadline = Date.now() + STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
    for (;;) {
      this.signal.throwIfAborted();
      try {
        return await this.client.request("chat.history", {
          sessionKey: opts.sessionKey,
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          limit: opts.limit,
        });
      } catch (err) {
        if (Date.now() >= deadline || !isRetryableStartupUnavailable(err, "chat.history")) {
          throw err;
        }
        await sleep(resolveStartupRetryDelayMs(err), this.signal);
      }
    }
  }
}
