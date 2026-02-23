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
