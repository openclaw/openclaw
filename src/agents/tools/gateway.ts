import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { getGatewayTimeoutMs } from "./timeout-config.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000; // 60 seconds - configurable via OPENCLAW_GATEWAY_TIMEOUT_MS env var

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

/**
 * Parse and validate timeout from environment variable
 * Prevents NaN and negative values from propagating
 */
function parseEnvTimeout(value: string | undefined): number | null {
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);

  // Validate: must be finite and positive
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[Gateway] Invalid timeout value "${value}". Using default ${DEFAULT_GATEWAY_TIMEOUT_MS}ms`,
    );
    return null;
  }

  return parsed;
}

export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  // Prefer an explicit override; otherwise let callGateway choose based on config.
  const url =
    typeof opts?.gatewayUrl === "string" && opts.gatewayUrl.trim()
      ? opts.gatewayUrl.trim()
      : undefined;
  const token =
    typeof opts?.gatewayToken === "string" && opts.gatewayToken.trim()
      ? opts.gatewayToken.trim()
      : undefined;

  // Read from environment variable with validation, or use getGatewayTimeoutMs()
  const envTimeoutMs = parseEnvTimeout(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS) ?? getGatewayTimeoutMs();

  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : envTimeoutMs;
  return { url, token, timeoutMs };
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean },
) {
  const gateway = resolveGatewayOptions(opts);
  return await callGateway<T>({
    url: gateway.url,
    token: gateway.token,
    method,
    params,
    timeoutMs: gateway.timeoutMs,
    expectFinal: extra?.expectFinal,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
}
