import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { NodeEventHandleResult } from "./server-node-events-types.js";

export function pruneBoundedTimestampMap(
  map: Map<string, number>,
  params: { now: number; ttlMs: number; maxEntries: number },
) {
  if (map.size <= params.maxEntries) {
    return;
  }
  const cutoff = params.now - params.ttlMs;
  for (const [key, ts] of map) {
    if (ts < cutoff) {
      map.delete(key);
    }
    if (map.size <= params.maxEntries) {
      return;
    }
  }
  pruneMapToMaxSize(map, params.maxEntries);
}

export async function isNodeEventConnectionCurrent(opts?: {
  isConnectionCurrent?: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (!opts?.isConnectionCurrent) {
    return true;
  }
  try {
    return await opts.isConnectionCurrent();
  } catch {
    return false;
  }
}

export function pairingChangedResult(event: string): NodeEventHandleResult {
  return { ok: true, event, handled: false, reason: "pairing_changed" };
}

export function parsePayloadObject(payloadJSON?: string | null): Record<string, unknown> | null {
  return payloadJSON ? asNullableObjectRecord(safeParseJson(payloadJSON)) : null;
}
