import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayRestartIntent } from "./restart-lifecycle.types.js";

const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;

export function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function decodeGatewayRestartIntent(
  row: unknown,
  pid: number,
  now: number,
): GatewayRestartIntent | null {
  if (
    !isRecord(row) ||
    row.kind !== "gateway-restart" ||
    row.pid !== pid ||
    typeof row.created_at !== "number" ||
    !Number.isFinite(row.created_at) ||
    now < row.created_at ||
    now - row.created_at > GATEWAY_RESTART_INTENT_TTL_MS ||
    (row.reason !== null && typeof row.reason !== "string") ||
    (row.force !== null && (typeof row.force !== "number" || !Number.isFinite(row.force))) ||
    (row.wait_ms !== null &&
      (typeof row.wait_ms !== "number" || !Number.isFinite(row.wait_ms) || row.wait_ms < 0))
  ) {
    return null;
  }
  const reason = normalizeRestartIntentReason(row.reason ?? undefined);
  return {
    ...(reason ? { reason } : {}),
    ...(row.force ? { force: true } : {}),
    ...(typeof row.wait_ms === "number" ? { waitMs: Math.floor(row.wait_ms) } : {}),
  };
}
