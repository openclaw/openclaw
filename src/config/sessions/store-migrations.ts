// Session store migrations repair legacy field names during load/save normalization.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "./types.js";

/** Applies best-effort in-place migrations for legacy session store entry fields. */
export function applySessionStoreMigrations(store: Record<string, SessionEntry>): boolean {
  let changed = false;
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    const rec = asOptionalRecord(entry);
    if (!rec) {
      continue;
    }
    for (const [legacy, current] of [
      ["provider", "channel"],
      ["lastProvider", "lastChannel"],
    ] as const) {
      if (typeof rec[current] !== "string" && typeof rec[legacy] === "string") {
        rec[current] = rec[legacy];
        delete rec[legacy];
        changed = true;
      }
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec["room"] === "string") {
      rec.groupChannel = rec["room"];
      delete rec["room"];
      changed = true;
    } else if ("room" in rec) {
      delete rec["room"];
      changed = true;
    }
  }
  return changed;
}
