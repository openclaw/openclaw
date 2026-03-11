import { URL } from "node:url";

export type ApnsRelayPushType = "alert" | "background";

export type ApnsRelayConfig = {
  baseUrl: string;
  authToken: string;
  timeoutMs: number;
};

export type ApnsRelayConfigResolution =
  | { ok: true; value: ApnsRelayConfig }
  | { ok: false; error: string };

export type ApnsRelayPushResponse = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  environment: "production";
  tokenSuffix?: string;
};

export type ApnsRelayRequestSender = (params: {
  relayConfig: ApnsRelayConfig;
  relayHandle: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}) => Promise<ApnsRelayPushResponse>;

const DEFAULT_APNS_RELAY_TIMEOUT_MS = 10_000;

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimeoutMs(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  return Math.max(1000, Math.trunc(parsed));
}

function readAllowHttp(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackRelayHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveApnsRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApnsRelayConfigResolution {
  const baseUrl = normalizeNonEmptyString(env.OPENCLAW_APNS_RELAY_BASE_URL);
  const authToken = normalizeNonEmptyString(env.OPENCLAW_APNS_RELAY_AUTH_TOKEN);
  if (!baseUrl || !authToken) {
    return {
      ok: false,
      error:
        "APNs relay config missing: set OPENCLAW_APNS_RELAY_BASE_URL and OPENCLAW_APNS_RELAY_AUTH_TOKEN",
    };
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    if (parsed.protocol === "http:" && !readAllowHttp(env.OPENCLAW_APNS_RELAY_ALLOW_HTTP)) {
      throw new Error(
        "http relay URLs require OPENCLAW_APNS_RELAY_ALLOW_HTTP=true (development only)",
      );
    }
    if (parsed.protocol === "http:" && !isLoopbackRelayHostname(parsed.hostname)) {
      throw new Error("http relay URLs are limited to loopback hosts");
    }
    return {
      ok: true,
      value: {
        baseUrl: parsed.toString().replace(/\/+$/, ""),
        authToken,
        timeoutMs: normalizeTimeoutMs(env.OPENCLAW_APNS_RELAY_TIMEOUT_MS),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `invalid OPENCLAW_APNS_RELAY_BASE_URL (${baseUrl}): ${message}`,
    };
  }
}

async function sendApnsRelayRequest(params: {
  relayConfig: ApnsRelayConfig;
  relayHandle: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}): Promise<ApnsRelayPushResponse> {
  const response = await fetch(`${params.relayConfig.baseUrl}/v1/push/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.relayConfig.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      relayHandle: params.relayHandle,
      pushType: params.pushType,
      priority: Number(params.priority),
      payload: params.payload,
    }),
    signal: AbortSignal.timeout(params.relayConfig.timeoutMs),
  });

  let json: unknown = null;
  try {
    json = (await response.json()) as unknown;
  } catch {
    json = null;
  }
  const body =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};

  const status =
    typeof body.status === "number" && Number.isFinite(body.status)
      ? Math.trunc(body.status)
      : response.status;
  return {
    ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
    status,
    apnsId: parseReason(body.apnsId),
    reason: parseReason(body.reason),
    environment: "production",
    tokenSuffix: parseReason(body.tokenSuffix),
  };
}

export async function sendApnsRelayPush(params: {
  relayConfig: ApnsRelayConfig;
  relayHandle: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
  requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsRelayPushResponse> {
  const sender = params.requestSender ?? sendApnsRelayRequest;
  return await sender({
    relayConfig: params.relayConfig,
    relayHandle: params.relayHandle,
    pushType: params.pushType,
    priority: params.priority,
    payload: params.payload,
  });
}
