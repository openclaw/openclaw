import { loadConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../infra/push-apns.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const CHAT_REPLY_APNS_TITLE = "OpenClaw";
const CHAT_REPLY_APNS_BODY_MAX_CHARS = 240;
const CHAT_REPLY_MAIN_SESSION_FALLBACK = "main";

export function normalizeChatReplyNotificationBody(rawText: string): string {
  const collapsed = rawText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= CHAT_REPLY_APNS_BODY_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, CHAT_REPLY_APNS_BODY_MAX_CHARS - 1).trimEnd()}…`;
}

export async function maybeSendChatReplyApnsAlert(params: {
  sessionKey: string;
  mainSessionKey?: string | null;
  requestDeviceId?: string | null;
  requestConnId?: string | null;
  replyText: string;
  isConnIdConnected?: (connId: string) => boolean;
  hasConnectedClientForDevice?: (deviceId: string, opts?: { excludeConnId?: string }) => boolean;
  logWarn?: (message: string) => void;
}): Promise<void> {
  const cfg = loadConfig();
  const mainSessionKey =
    normalizeOptionalString(params.mainSessionKey) ??
    normalizeOptionalString(cfg.session?.mainKey) ??
    CHAT_REPLY_MAIN_SESSION_FALLBACK;
  if (params.sessionKey !== mainSessionKey) {
    return;
  }

  const deviceId = normalizeOptionalString(params.requestDeviceId) ?? "";
  if (!deviceId) {
    return;
  }

  const requestConnId = normalizeOptionalString(params.requestConnId) ?? undefined;
  if (requestConnId && params.isConnIdConnected?.(requestConnId)) {
    return;
  }
  if (params.hasConnectedClientForDevice?.(deviceId, { excludeConnId: requestConnId })) {
    return;
  }

  const body = normalizeChatReplyNotificationBody(params.replyText);
  if (!body) {
    return;
  }

  try {
    const registration = await loadApnsRegistration(deviceId);
    if (!registration) {
      return;
    }

    const result =
      registration.transport === "relay"
        ? await (async () => {
            const relay = resolveApnsRelayConfigFromEnv(process.env, cfg.gateway);
            if (!relay.ok) {
              params.logWarn?.(`chat APNs relay unavailable device=${deviceId}: ${relay.error}`);
              return null;
            }
            return await sendApnsAlert({
              registration,
              nodeId: deviceId,
              title: CHAT_REPLY_APNS_TITLE,
              body,
              relayConfig: relay.value,
            });
          })()
        : await (async () => {
            const auth = await resolveApnsAuthConfigFromEnv(process.env);
            if (!auth.ok) {
              params.logWarn?.(`chat APNs auth unavailable device=${deviceId}: ${auth.error}`);
              return null;
            }
            return await sendApnsAlert({
              registration,
              nodeId: deviceId,
              title: CHAT_REPLY_APNS_TITLE,
              body,
              auth: auth.value,
            });
          })();

    if (!result) {
      return;
    }
    if (
      shouldClearStoredApnsRegistration({
        registration,
        result,
      })
    ) {
      await clearApnsRegistrationIfCurrent({
        nodeId: deviceId,
        registration,
      });
    }
    if (!result.ok) {
      params.logWarn?.(
        `chat APNs send failed device=${deviceId} status=${result.status} reason=${result.reason ?? "-"}`,
      );
    }
  } catch (error) {
    params.logWarn?.(`chat APNs send threw device=${deviceId}: ${formatErrorMessage(error)}`);
  }
}
