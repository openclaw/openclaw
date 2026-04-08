import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function parseRestartRequestParams(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
} {
  const sessionKey = normalizeOptionalString((params as { sessionKey?: unknown }).sessionKey);
  const note = normalizeOptionalString((params as { note?: unknown }).note);
  const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
  const restartDelayMs =
    typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
      ? Math.max(0, Math.floor(restartDelayMsRaw))
      : undefined;
  return { sessionKey, note, restartDelayMs };
}
