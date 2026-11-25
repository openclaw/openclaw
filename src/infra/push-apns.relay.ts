import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayConfig } from "../config/types.gateway.js";
import { normalizeApnsRelayBaseUrl } from "./push-apns-relay-url.js";

export type ApnsRelayConfig = {
  baseUrl: string;
  timeoutMs: number;
};

type ApnsRelayConfigResolution =
  | { ok: true; value: ApnsRelayConfig }
  | { ok: false; error: string };

type ApnsRelayConfigResolutionOptions = {
  registrationRelayOrigin?: string;
};

/** Hosted APNs relay origin used only when registrations prove they were minted there. */
const DEFAULT_APNS_RELAY_BASE_URL = "https://ios-push-relay.openclaw.ai";
const DEFAULT_APNS_SANDBOX_RELAY_BASE_URL = "https://ios-push-relay-sandbox.openclaw.ai";
const DEFAULT_APNS_RELAY_TIMEOUT_MS = 10_000;
function normalizeTimeoutMs(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : parseStrictPositiveInteger(value);
  return resolveTimerTimeoutMs(parsed, DEFAULT_APNS_RELAY_TIMEOUT_MS, 1000);
}

/** Resolve the relay endpoint from env/config and require it to match relay-minted registrations. */
export function resolveApnsRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayConfig?: GatewayConfig,
  options: ApnsRelayConfigResolutionOptions = {},
): ApnsRelayConfigResolution {
  const configuredRelay = gatewayConfig?.push?.apns?.relay;
  const envBaseUrl = normalizeOptionalString(env.OPENCLAW_APNS_RELAY_BASE_URL);
  const configBaseUrl = normalizeOptionalString(configuredRelay?.baseUrl);
  const explicitBaseUrl = envBaseUrl ?? configBaseUrl;
  const normalizedRegistrationOrigin = options.registrationRelayOrigin
    ? normalizeApnsRelayBaseUrl(options.registrationRelayOrigin, env)
    : undefined;
  if (normalizedRegistrationOrigin && !normalizedRegistrationOrigin.ok) {
    return {
      ok: false,
      error: `invalid relay registration origin (${options.registrationRelayOrigin}): ${normalizedRegistrationOrigin.error}`,
    };
  }

  const hostedRelayBaseUrl =
    normalizedRegistrationOrigin?.value === DEFAULT_APNS_RELAY_BASE_URL
      ? DEFAULT_APNS_RELAY_BASE_URL
      : normalizedRegistrationOrigin?.value === DEFAULT_APNS_SANDBOX_RELAY_BASE_URL
        ? DEFAULT_APNS_SANDBOX_RELAY_BASE_URL
        : undefined;
  const baseUrl = explicitBaseUrl ?? hostedRelayBaseUrl;
  const baseUrlSource = envBaseUrl
    ? "OPENCLAW_APNS_RELAY_BASE_URL"
    : configBaseUrl
      ? "gateway.push.apns.relay.baseUrl"
      : "default APNs relay base URL";
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL for relay registrations without the hosted relay origin",
    };
  }

  const normalizedBaseUrl = normalizeApnsRelayBaseUrl(baseUrl, env);
  if (!normalizedBaseUrl.ok) {
    return {
      ok: false,
      error: `invalid ${baseUrlSource} (${baseUrl}): ${normalizedBaseUrl.error}`,
    };
  }
  if (
    normalizedRegistrationOrigin &&
    normalizedRegistrationOrigin.value !== normalizedBaseUrl.value
  ) {
    return {
      ok: false,
      error: `APNs relay config origin mismatch: registration uses ${normalizedRegistrationOrigin.value} but ${baseUrlSource} is ${normalizedBaseUrl.value}`,
    };
  }
  return {
    ok: true,
    value: {
      baseUrl: normalizedBaseUrl.value,
      timeoutMs: normalizeTimeoutMs(
        normalizeOptionalString(env.OPENCLAW_APNS_RELAY_TIMEOUT_MS) ?? configuredRelay?.timeoutMs,
      ),
    },
  };
}
