/**
 * Parse the live deliveryContext passed by gateway-tool clients.
 *
 * Clients capture delivery context from the active agent run and forward it
 * so server-side handlers can write an accurate sentinel without reading the
 * persisted session store, which heartbeat runs frequently overwrite to
 * { channel: "webchat", to: "heartbeat" }. See #18612.
 */
export function parseDeliveryContextFromParams(
  params: unknown,
): { channel?: string; to?: string; accountId?: string; threadId?: string } | undefined {
  const raw = (params as { deliveryContext?: unknown }).deliveryContext;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const channel =
    typeof (raw as { channel?: unknown }).channel === "string"
      ? (raw as { channel: string }).channel.trim() || undefined
      : undefined;
  const to =
    typeof (raw as { to?: unknown }).to === "string"
      ? (raw as { to: string }).to.trim() || undefined
      : undefined;
  const accountId =
    typeof (raw as { accountId?: unknown }).accountId === "string"
      ? (raw as { accountId: string }).accountId.trim() || undefined
      : undefined;
  const threadId =
    typeof (raw as { threadId?: unknown }).threadId === "string"
      ? (raw as { threadId: string }).threadId.trim() || undefined
      : undefined;
  // Require both channel and to — a partial context can overwrite a complete
  // extracted route and produce a non-routable sentinel. See #18612.
  if (!channel || !to) {
    return undefined;
  }
  return { channel, to, accountId, threadId };
}

export function parseRestartRequestParams(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
} {
  const sessionKey =
    typeof (params as { sessionKey?: unknown }).sessionKey === "string"
      ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
      : undefined;
  const note =
    typeof (params as { note?: unknown }).note === "string"
      ? (params as { note?: string }).note?.trim() || undefined
      : undefined;
  const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
  const restartDelayMs =
    typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
      ? Math.max(0, Math.floor(restartDelayMsRaw))
      : undefined;
  return { sessionKey, note, restartDelayMs };
}
