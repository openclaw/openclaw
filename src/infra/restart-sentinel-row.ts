import type { RestartSentinelPayload } from "./restart-sentinel-store.js";

export function buildRestartSentinelRow(
  payload: RestartSentinelPayload,
  revision: number,
  sentinelKey: string,
) {
  return {
    sentinel_key: sentinelKey,
    version: 1,
    kind: payload.kind,
    status: payload.status,
    ts: payload.ts,
    session_key: payload.sessionKey ?? null,
    thread_id: payload.threadId ?? null,
    delivery_channel: payload.deliveryContext?.channel ?? null,
    delivery_to: payload.deliveryContext?.to ?? null,
    delivery_account_id: payload.deliveryContext?.accountId ?? null,
    message: payload.message ?? null,
    continuation_json: payload.continuation ? JSON.stringify(payload.continuation) : null,
    doctor_hint: payload.doctorHint ?? null,
    stats_json: payload.stats ? JSON.stringify(payload.stats) : null,
    // Debug shadow only. Reads reconstruct exclusively from typed columns above.
    payload_json: JSON.stringify(payload),
    updated_at_ms: revision,
  };
}
