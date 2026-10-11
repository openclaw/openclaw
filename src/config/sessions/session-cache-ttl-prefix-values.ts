import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isCacheTtlTouch,
  readCacheTtlCheckpoint,
} from "../../agents/embedded-agent-runner/cache-ttl-checkpoint.js";
import type { CacheTtlProjectionPrefix } from "./session-accessor.sqlite-contract.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";

/** Read newest first and stop at the reset or checkpoint that owns this prefix. */
export function collectCacheTtlProjectionPrefix(
  anchor: { id: string; entry: unknown },
  preceding: Iterable<unknown>,
): CacheTtlProjectionPrefix | undefined {
  if (
    isIndexedSessionEntry(anchor.entry) &&
    (anchor.entry.type === "reset" || readCacheTtlCheckpoint([anchor.entry]))
  ) {
    return undefined;
  }
  const prefix: Record<string, unknown>[] = [];
  for (const entry of preceding) {
    if (
      !isIndexedSessionEntry(entry) ||
      (entry.type !== "reset" &&
        (entry.type !== "custom" ||
          entry.customType !== "openclaw.cache-ttl" ||
          isCacheTtlTouch(entry.data)))
    ) {
      continue;
    }
    if (isRecord(entry)) {
      prefix.push(entry);
    }
    if (entry.type === "reset" || readCacheTtlCheckpoint([entry])) {
      break;
    }
  }
  return prefix.length ? { anchorIds: [anchor.id], entries: prefix.toReversed() } : undefined;
}
