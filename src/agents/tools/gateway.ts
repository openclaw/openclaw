import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

/** Default timeout for gateway tool calls (increased from 10s to 30s for busy gateways) */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Maximum retry attempts on timeout */
const MAX_RETRY_ATTEMPTS = 2;

/** Delay between retries (doubles each attempt) */
const RETRY_BASE_DELAY_MS = 500;

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

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
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : DEFAULT_TOOL_TIMEOUT_MS;
  return { url, token, timeoutMs };
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("gateway timeout");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean },
): Promise<T> {
  const gateway = resolveGatewayOptions(opts);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
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
    } catch (err) {
      lastError = err as Error;

      // Only retry on timeout errors
      if (!isTimeoutError(err)) {
        throw err;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        break;
      }

      // Exponential backoff before retry
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  // All retries exhausted
  throw lastError;
}
