import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelApprovalKind } from "./approval-types.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "./device-identity-async.js";
import { signDevicePayload } from "./device-identity.js";
import { toErrorObject } from "./errors.js";
import { readResponseWithLimit } from "./http-body.js";
import { getApnsBearerToken, type ApnsAuthConfig } from "./push-apns-auth.js";
import {
  APNS_HTTP2_CANCEL_CODE,
  appendApnsResponseBodyCapture,
  connectApnsHttp2Session,
  createApnsResponseBodyCapture,
  getApnsResponseBodyCaptureText,
} from "./push-apns-http2.js";
import { apnsSendInvalidatedError, requireCurrentApnsSend } from "./push-apns-send-current.js";
import {
  isLikelyApnsToken,
  isValidApnsTopic,
  normalizeApnsToken,
  normalizeApnsTopic,
  type ApnsEnvironment,
  type ApnsRegistration,
  type DirectApnsRegistration,
  type RelayApnsRegistration,
} from "./push-apns-store.js";
import { type ApnsRelayConfig, resolveApnsRelayConfigFromEnv } from "./push-apns.relay.js";

export {
  ApnsRegistrationPairingChangedError,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  normalizeApnsEnvironment,
  registerApnsRegistration,
} from "./push-apns-store.js";
export type { ApnsRegistration } from "./push-apns-store.js";
export { resolveApnsAuthConfigFromEnv } from "./push-apns-auth.js";
export type { ApnsAuthConfig } from "./push-apns-auth.js";

// Hard cap on the relay response body. The hosted relay reply is a tiny JSON status object;
// without a cap a buggy/hostile/compromised relay could stream an unbounded body and exhaust
// gateway memory (the existing AbortSignal.timeout only bounds connection latency, not body size).
const APNS_RELAY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const GATEWAY_DEVICE_ID_HEADER = "x-openclaw-gateway-device-id";
const GATEWAY_SIGNATURE_HEADER = "x-openclaw-gateway-signature";
const GATEWAY_SIGNED_AT_HEADER = "x-openclaw-gateway-signed-at-ms";

function parseRelayEnvironment(value: unknown): ApnsEnvironment | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "sandbox" || normalized === "production" ? normalized : undefined;
}

type ApnsRelayPushResponse = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  environment?: ApnsEnvironment;
  tokenSuffix?: string;
};

// Sentinel marking an over-cap relay body. Carried as a distinct type so the response-read
// catch path can fail closed on overflow instead of swallowing it into the malformed-JSON
// (treat-as-empty-body) fallback that would otherwise report a successful send.
class ApnsRelayResponseTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`APNs relay response exceeded ${maxBytes} bytes (${size} bytes received)`);
    this.name = "ApnsRelayResponseTooLargeError";
  }
}

type ApnsTransport = "direct" | "relay";

type ApnsPushResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  tokenSuffix: string;
  topic: string;
  environment: ApnsEnvironment;
  transport: ApnsTransport;
};

const EXEC_APPROVAL_NOTIFICATION_CATEGORY = "openclaw.exec-approval";
const PLUGIN_APPROVAL_NOTIFICATION_CATEGORY = "openclaw.plugin-approval";

type ApnsPushType = "alert" | "background";

type ApnsRequestParams = {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
};

type ApnsRequestResponse = { status: number; apnsId?: string; body: string };

type ApnsRequestSender = (params: ApnsRequestParams) => Promise<ApnsRequestResponse>;

const DEFAULT_APNS_TIMEOUT_MS = 10_000;
const PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH = 256;

function createApnsApprovalAlertPayload(params: {
  kind: ChannelApprovalKind;
  approvalId: string;
  gatewayDeviceId: string;
  title: string;
  body: string;
  category: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
      category: params.category,
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.requested`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}

function resolvePluginApprovalAlertBody(description: string): string {
  const body = normalizeOptionalString(description) ?? "";
  if (body.length <= PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH) {
    return body;
  }
  return `${truncateUtf16Safe(body, PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

function parseReason(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : truncateUtf16Safe(trimmed, 200);
  } catch {
    return truncateUtf16Safe(trimmed, 200);
  }
}

export function shouldClearStoredApnsRegistration(params: {
  registration: ApnsRegistration;
  result: { status: number; reason?: string };
  overrideEnvironment?: ApnsEnvironment | null;
}): boolean {
  if (params.registration.transport !== "direct") {
    return false;
  }
  if (
    params.overrideEnvironment &&
    params.overrideEnvironment !== params.registration.environment
  ) {
    return false;
  }
  const { status, reason } = params.result;
  return status === 410 || (status === 400 && reason?.trim() === "BadDeviceToken");
}

async function sendApnsRequest(params: ApnsRequestParams): Promise<ApnsRequestResponse> {
  const authority =
    params.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const body = JSON.stringify(params.payload);
  const requestPath = `/3/device/${params.token}`;

  const client = await connectApnsHttp2Session({
    authority,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  // Connection failures can arrive while the persistent ownership check is
  // yielding. Keep a consuming owner until the session closes, while the
  // request-specific listener below still rejects the active send.
  const consumeSessionError = () => undefined;
  client.on("error", consumeSessionError);
  client.once("close", () => client.off("error", consumeSessionError));

  return await new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest: ReturnType<typeof client.request> | undefined;
    const cleanup = () => {
      client.off("error", fail);
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: unknown, options?: { cancelRequest?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (options?.cancelRequest && activeRequest && !activeRequest.destroyed) {
        activeRequest.close(APNS_HTTP2_CANCEL_CODE);
        client.close();
      } else {
        client.destroy();
      }
      reject(toErrorObject(err, "Non-Error rejection"));
    };
    const onAbort = () => fail(apnsSendInvalidatedError(params.signal), { cancelRequest: true });
    const finish = (result: { status: number; apnsId?: string; body: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      client.close();
      resolve(result);
    };

    const startRequest = async () => {
      try {
        await requireCurrentApnsSend(params);
        if (settled) {
          return;
        }
        if (params.signal?.aborted) {
          onAbort();
          return;
        }

        const req = client.request({
          ":method": "POST",
          ":path": requestPath,
          authorization: `bearer ${params.bearerToken}`,
          "apns-topic": params.topic,
          "apns-push-type": params.pushType,
          "apns-priority": params.priority,
          "apns-expiration": "0",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
        });
        activeRequest = req;

        let statusCode = 0;
        let apnsId: string | undefined;
        const responseBody = createApnsResponseBodyCapture();

        req.setTimeout(params.timeoutMs, () => {
          fail(new Error(`APNs request timed out after ${params.timeoutMs}ms`), {
            cancelRequest: true,
          });
        });
        req.on("response", (headers) => {
          const statusHeader = headers[":status"];
          statusCode = statusHeader ?? 0;
          const idHeader = headers["apns-id"];
          if (typeof idHeader === "string" && idHeader.trim().length > 0) {
            apnsId = idHeader.trim();
          }
        });
        req.on("data", (chunk) => {
          appendApnsResponseBodyCapture(responseBody, chunk);
        });
        req.on("end", () => {
          finish({
            status: statusCode,
            apnsId,
            body: getApnsResponseBodyCaptureText(responseBody),
          });
        });
        req.on("error", (err) => fail(err));

        if (params.signal?.aborted) {
          onAbort();
          return;
        }
        req.end(body);
      } catch (error) {
        fail(error);
      }
    };

    client.once("error", fail);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    void startRequest();
  });
}

function toPushResult(params: {
  registration: ApnsRegistration;
  response: ApnsRequestResponse | ApnsRelayPushResponse;
  tokenSuffix?: string;
}): ApnsPushResult {
  const { registration, response } = params;
  const direct = "body" in response;
  return {
    ok: direct ? response.status === 200 : response.ok,
    status: response.status,
    apnsId: response.apnsId,
    reason: direct ? parseReason(response.body) : response.reason,
    tokenSuffix:
      params.tokenSuffix ??
      (registration.transport === "direct"
        ? registration.token.slice(-8)
        : ((!direct ? response.tokenSuffix : undefined) ??
          registration.tokenDebugSuffix ??
          registration.relayHandle.slice(-8))),
    topic: registration.topic,
    environment: direct
      ? registration.environment
      : (response.environment ?? registration.environment),
    transport: registration.transport,
  };
}

type ApnsTransportCommonParams = {
  nodeId: string;
  timeoutMs?: number;
};

type DirectApnsTransportParams = ApnsTransportCommonParams & {
  registration: DirectApnsRegistration;
  auth: ApnsAuthConfig;
  requestSender?: ApnsRequestSender;
  relayConfig?: never;
};

type RelayApnsTransportParams = ApnsTransportCommonParams & {
  registration: RelayApnsRegistration;
  relayConfig: ApnsRelayConfig;
  auth?: never;
  requestSender?: never;
};

type ApnsTransportParams = DirectApnsTransportParams | RelayApnsTransportParams;
type ApnsLifecycleControls = Pick<ApnsRequestParams, "signal" | "isCurrent">;

type ApnsAlertParams = ApnsTransportParams &
  ApnsLifecycleControls & {
    title: string;
    body: string;
  };

type ApnsBackgroundWakeParams = ApnsTransportParams &
  ApnsLifecycleControls & {
    wakeReason?: string;
  };

type ApnsApprovalParams = ApnsTransportParams & {
  approvalId: string;
  gatewayDeviceId: string;
};

type ApnsPluginApprovalAlertParams = ApnsApprovalParams & {
  title?: string | null;
  description: string;
};

export async function sendApnsAlert(params: ApnsAlertParams): Promise<ApnsPushResult> {
  const payload = {
    aps: {
      alert: { title: params.title, body: params.body },
      sound: "default",
    },
    openclaw: { kind: "push.test", nodeId: params.nodeId, ts: Date.now() },
  };

  return await sendApnsPush({ transport: params, payload, pushType: "alert" }, params);
}

export async function sendApnsBackgroundWake(
  params: ApnsBackgroundWakeParams,
): Promise<ApnsPushResult> {
  const reason = params.wakeReason ?? "node.invoke";
  const payload = {
    aps: { "content-available": 1 },
    openclaw: {
      kind: "node.wake",
      nodeId: params.nodeId,
      ts: Date.now(),
      ...(reason ? { reason } : {}),
    },
  };

  return await sendApnsPush({ transport: params, payload, pushType: "background" }, params);
}

async function sendApnsPush(
  params: {
    transport: ApnsTransportParams;
    payload: object;
    pushType: ApnsPushType;
  },
  // Approval notifications have no lifecycle controls, including extra JS input fields.
  controls?: ApnsLifecycleControls,
): Promise<ApnsPushResult> {
  const transport = params.transport;
  const priority = params.pushType === "alert" ? "10" : "5";
  const lifecycleControls = {
    ...(controls?.signal ? { signal: controls.signal } : {}),
    ...(controls?.isCurrent ? { isCurrent: controls.isCurrent } : {}),
  };
  if (transport.registration.transport === "relay") {
    const relayParams = transport as RelayApnsTransportParams;
    const registration = relayParams.registration;
    const gatewayIdentity = await loadOrCreateProcessDeviceIdentityAsync();
    await requireCurrentApnsSend(lifecycleControls);
    const signedAtMs = Date.now();
    const bodyJson = JSON.stringify({
      relayHandle: registration.relayHandle,
      pushType: params.pushType,
      priority: Number(priority),
      payload: params.payload,
    });
    const signature = signDevicePayload(
      gatewayIdentity.privateKeyPem,
      // Domain-separate relay send signatures from other gateway/device signatures.
      [
        "openclaw-relay-send-v1",
        gatewayIdentity.deviceId.trim(),
        String(Math.trunc(signedAtMs)),
        bodyJson,
      ].join("\n"),
    );
    await requireCurrentApnsSend(lifecycleControls);
    const timeoutSignal = AbortSignal.timeout(relayParams.relayConfig.timeoutMs);
    const signal = lifecycleControls.signal
      ? AbortSignal.any([lifecycleControls.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(`${relayParams.relayConfig.baseUrl}/v1/push/send`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${registration.sendGrant}`,
        "content-type": "application/json",
        [GATEWAY_DEVICE_ID_HEADER]: gatewayIdentity.deviceId,
        [GATEWAY_SIGNATURE_HEADER]: signature,
        [GATEWAY_SIGNED_AT_HEADER]: String(signedAtMs),
      },
      body: bodyJson,
      signal,
    });
    // Do not follow relay redirects; grants and signatures are scoped to the configured relay origin.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return toPushResult({
        registration,
        response: { ok: false, status: response.status, reason: "RelayRedirectNotAllowed" },
      });
    }

    let json: unknown;
    try {
      // Bound the relay body before buffering it; cancel the stream past the cap.
      const buffer = await readResponseWithLimit(response, APNS_RELAY_MAX_RESPONSE_BYTES, {
        onOverflow: ({ size, maxBytes }) => new ApnsRelayResponseTooLargeError(size, maxBytes),
      });
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch (err) {
      if (err instanceof ApnsRelayResponseTooLargeError) {
        // Fail closed: an oversized relay body must never be reported as a delivered push.
        return toPushResult({
          registration,
          response: { ok: false, status: response.status, reason: "RelayResponseTooLarge" },
        });
      }
      // Malformed/empty JSON (or a non-overflow body read error) keeps the prior behaviour:
      // treat the body as absent and derive status/ok from the HTTP response.
      json = null;
    }
    const body = isRecord(json) ? json : {};

    const status =
      typeof body.status === "number" && Number.isFinite(body.status)
        ? Math.trunc(body.status)
        : response.status;
    const environment = parseRelayEnvironment(body.environment);
    return toPushResult({
      registration,
      response: {
        ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
        status,
        apnsId: normalizeOptionalString(body.apnsId),
        reason: normalizeOptionalString(body.reason),
        ...(environment ? { environment } : {}),
        tokenSuffix: normalizeOptionalString(body.tokenSuffix),
      },
    });
  }
  const { auth, registration, timeoutMs, requestSender } = transport as DirectApnsTransportParams;
  const token = normalizeApnsToken(registration.token);
  if (!isLikelyApnsToken(token)) {
    throw new Error("invalid APNs token");
  }
  const topic = normalizeApnsTopic(registration.topic);
  if (!isValidApnsTopic(topic)) {
    throw new Error("topic required");
  }
  const environment = registration.environment;
  const bearerToken = getApnsBearerToken(auth);
  await requireCurrentApnsSend(lifecycleControls);
  const sender = requestSender ?? sendApnsRequest;
  const response = await sender({
    token,
    topic,
    environment,
    bearerToken,
    payload: params.payload,
    timeoutMs: resolveTimerTimeoutMs(timeoutMs, DEFAULT_APNS_TIMEOUT_MS, 1000),
    pushType: params.pushType,
    priority,
    ...lifecycleControls,
  });
  return toPushResult({
    registration,
    response,
    tokenSuffix: token.slice(-8),
  });
}

export async function sendApnsExecApprovalAlert(
  params: ApnsApprovalParams,
): Promise<ApnsPushResult> {
  return await sendApnsPush({
    transport: params,
    payload: createApnsApprovalAlertPayload({
      kind: "exec",
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      title: "Exec approval required",
      body: "Open OpenClaw to review this request.",
      category: EXEC_APPROVAL_NOTIFICATION_CATEGORY,
    }),
    pushType: "alert",
  });
}

export async function sendApnsPluginApprovalAlert(
  params: ApnsPluginApprovalAlertParams,
): Promise<ApnsPushResult> {
  return await sendApnsPush({
    transport: params,
    payload: createApnsApprovalAlertPayload({
      kind: "plugin",
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      title: normalizeOptionalString(params.title) ?? "Approval required",
      body: resolvePluginApprovalAlertBody(params.description),
      category: PLUGIN_APPROVAL_NOTIFICATION_CATEGORY,
    }),
    pushType: "alert",
  });
}

async function sendApnsApprovalResolvedWake(params: {
  transport: ApnsApprovalParams;
  kind: ChannelApprovalKind;
}): Promise<ApnsPushResult> {
  return await sendApnsPush({
    transport: params.transport,
    payload: {
      aps: { "content-available": 1 },
      openclaw: {
        kind: `${params.kind}.approval.resolved`,
        approvalId: params.transport.approvalId,
        gatewayDeviceId: params.transport.gatewayDeviceId,
        ts: Date.now(),
      },
    },
    pushType: "background",
  });
}

export async function sendApnsExecApprovalResolvedWake(
  params: ApnsApprovalParams,
): Promise<ApnsPushResult> {
  return await sendApnsApprovalResolvedWake({ transport: params, kind: "exec" });
}

export async function sendApnsPluginApprovalResolvedWake(
  params: ApnsApprovalParams,
): Promise<ApnsPushResult> {
  return await sendApnsApprovalResolvedWake({ transport: params, kind: "plugin" });
}

export { type ApnsRelayConfig, resolveApnsRelayConfigFromEnv };
