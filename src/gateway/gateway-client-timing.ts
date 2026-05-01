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

const KNOWN_TIMING_STAGES = new Set<GatewayClientTimingStage>([
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

const SAFE_TIMING_STRING = /^[A-Za-z0-9_.:-]{1,120}$/;

function isGatewayClientTimingStage(value: string): value is GatewayClientTimingStage {
  return KNOWN_TIMING_STAGES.has(value as GatewayClientTimingStage);
}

export function isGatewayClientTimingDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] === "1";
}

function sanitizeTimingString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!SAFE_TIMING_STRING.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function resolveErrorCode(err: Error): string | undefined {
  const gatewayCode = sanitizeTimingString(Reflect.get(err, "gatewayCode"));
  if (gatewayCode) {
    return gatewayCode;
  }
  const code = Reflect.get(err, "code");
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  return sanitizeTimingString(code);
}

export function sanitizeGatewayClientTimingPayload(
  input: Record<string, unknown>,
): GatewayClientTimingEvent | null {
  const stage = input.stage;
  if (typeof stage !== "string" || !isGatewayClientTimingStage(stage)) {
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
  const method = sanitizeTimingString(input.method);
  if (!method) {
    return null;
  }
  const requestKind = sanitizeTimingString(input.requestKind);
  if (!requestKind) {
    return null;
  }
  const out: GatewayClientTimingEvent = {
    stage,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    ok,
    method,
    requestKind,
  };
  const errorName = sanitizeTimingString(input.errorName);
  if (errorName) {
    out.errorName = errorName;
  }
  const errorCode = sanitizeTimingString(input.errorCode);
  if (errorCode) {
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
  const baseMethod = sanitizeTimingString(method) ?? "unknown";
  const baseRequestKind = sanitizeTimingString(requestKind) ?? "unknown";
  const t0 = performance.now();
  return {
    emit(stage, ok, err, opts) {
      const resolvedMethod = sanitizeTimingString(opts?.method) ?? baseMethod;
      const resolvedRequestKind = sanitizeTimingString(opts?.requestKind) ?? baseRequestKind;
      emitGatewayClientTimingEvent(
        {
          stage,
          elapsedMs: performance.now() - t0,
          ok,
          method: resolvedMethod,
          requestKind: resolvedRequestKind,
          ...(err
            ? {
                errorName: sanitizeTimingString(err.name),
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
