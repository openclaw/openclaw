import { logDebug } from "../logger.js";

export const OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG = "OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG";

export type GatewayClientTimingStage =
  | "executeGatewayRequestWithScopes_entered"
  | "event_loop_ready"
  | "ws_open"
  | "connect_handshake"
  | "hello_ok"
  | "request_send"
  | "response_wait"
  | "frame_receive_parse"
  | "request_settle"
  | "command_complete";

export type GatewayClientTimingEvent = {
  stage: GatewayClientTimingStage;
  elapsedMs: number;
  ok: boolean;
  method: string;
  requestKind: string;
  errorName?: string;
  errorCode?: string;
};

const KNOWN_TIMING_STAGES = new Set<string>([
  "executeGatewayRequestWithScopes_entered",
  "event_loop_ready",
  "ws_open",
  "connect_handshake",
  "hello_ok",
  "request_send",
  "response_wait",
  "frame_receive_parse",
  "request_settle",
  "command_complete",
]);

export function isGatewayClientTimingDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] === "1";
}

function resolveErrorCode(err: Error): string | undefined {
  const withGateway = err as Error & { gatewayCode?: unknown };
  if (typeof withGateway.gatewayCode === "string" && withGateway.gatewayCode.trim()) {
    return withGateway.gatewayCode.trim();
  }
  const withCode = err as Error & { code?: unknown };
  if (typeof withCode.code === "number" && Number.isFinite(withCode.code)) {
    return String(withCode.code);
  }
  if (typeof withCode.code === "string" && withCode.code.trim()) {
    return withCode.code.trim();
  }
  return undefined;
}

export function sanitizeGatewayClientTimingPayload(
  input: Record<string, unknown>,
): GatewayClientTimingEvent | null {
  const stage = input.stage;
  if (typeof stage !== "string" || !KNOWN_TIMING_STAGES.has(stage)) {
    return null;
  }
  const elapsedMs = input.elapsedMs;
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) {
    return null;
  }
  const ok = input.ok === true || input.ok === false ? input.ok : null;
  if (ok === null) {
    return null;
  }
  const method = input.method;
  if (typeof method !== "string") {
    return null;
  }
  const requestKind = input.requestKind;
  if (typeof requestKind !== "string") {
    return null;
  }
  const out: GatewayClientTimingEvent = {
    stage: stage as GatewayClientTimingStage,
    elapsedMs: Math.round(elapsedMs),
    ok,
    method,
    requestKind,
  };
  const errorName = input.errorName;
  if (typeof errorName === "string" && errorName.length > 0) {
    out.errorName = errorName;
  }
  const errorCode = input.errorCode;
  if (typeof errorCode === "string" && errorCode.length > 0) {
    out.errorCode = errorCode;
  }
  return out;
}

export function emitGatewayClientTimingEvent(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isGatewayClientTimingDebugEnabled(env)) {
    return;
  }
  const sanitized = sanitizeGatewayClientTimingPayload(raw);
  if (!sanitized) {
    return;
  }
  logDebug(`gateway.client.timing ${JSON.stringify(sanitized)}`);
}

export type GatewayClientTimingSession = {
  emit(
    stage: GatewayClientTimingStage,
    ok: boolean,
    err?: Error,
    opts?: { method?: string; requestKind?: string },
  ): void;
};

export function createGatewayClientTimingSession(
  method: string,
  requestKind: string,
  env: NodeJS.ProcessEnv = process.env,
): GatewayClientTimingSession | undefined {
  if (!isGatewayClientTimingDebugEnabled(env)) {
    return undefined;
  }
  const t0 = performance.now();
  return {
    emit(stage, ok, err, opts) {
      const resolvedMethod =
        typeof opts?.method === "string" && opts.method.length > 0 ? opts.method : method;
      const resolvedRequestKind =
        typeof opts?.requestKind === "string" && opts.requestKind.length > 0
          ? opts.requestKind
          : requestKind;
      emitGatewayClientTimingEvent(
        {
          stage,
          elapsedMs: performance.now() - t0,
          ok,
          method: resolvedMethod,
          requestKind: resolvedRequestKind,
          ...(err
            ? {
                errorName: err.name,
                errorCode: resolveErrorCode(err),
              }
            : {}),
        },
        env,
      );
    },
  };
}

export const __testing = {
  resetEnv(env: NodeJS.ProcessEnv): void {
    delete env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG];
  },
};
