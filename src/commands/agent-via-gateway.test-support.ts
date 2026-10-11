import path from "node:path";
import { GatewayPendingRequests } from "../../packages/gateway-client/src/pending-request.js";
import type { GatewayProtocolRequestError } from "../../packages/gateway-client/src/protocol-request.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayLockOptions } from "../infra/gateway-lock.js";

export function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    exitCode: undefined as NodeJS.Process["exitCode"],
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
    listenerCount(signal: SignalName) {
      return listeners.get(signal)?.size ?? 0;
    },
  };
}

export async function settleGatewayAgentRequest(params: {
  response: Pick<
    Parameters<GatewayPendingRequests["handleResponse"]>[0],
    "ok" | "payload" | "error"
  >;
  accepted?: unknown;
  onAccepted?: (payload: unknown) => void;
  requestError?: GatewayProtocolRequestError;
}) {
  const requestError = params.requestError;
  const pending = new GatewayPendingRequests({
    createRequestId: () => "request",
    nowMs: Date.now,
    createRequestError: requestError ? () => requestError : undefined,
  });
  const result = pending.request(
    { send: () => {} },
    "agent",
    {},
    { expectFinal: true, onAccepted: params.onAccepted },
  );
  if (params.accepted) {
    pending.handleResponse({ type: "res", id: "1:request", ok: true, payload: params.accepted });
  }
  pending.handleResponse({ type: "res", id: "1:request", ...params.response });
  if (requestError) {
    // Bound negative accepted-shaped frames without a wall-clock timeout.
    pending.flush(requestError);
  }
  return await result;
}

export function createLocalGatewayLockOptions(
  stateDir: string,
  overrides: Partial<GatewayLockOptions> = {},
): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    timeoutMs: 100,
    ...overrides,
  };
}

export function createExplicitSystemAgentConfig(
  agentId: string,
  agentIds: string[],
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId } },
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
}

export function createGatewayTimeoutError() {
  const err = new Error("gateway timeout after 90000ms");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "timeout",
    timeoutMs: 90_000,
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

export function createGatewayNormalCloseError() {
  const err = new Error("gateway closed (1000 normal closure): no close reason");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "closed",
    code: 1000,
    reason: "no close reason",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}
