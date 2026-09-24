// Transcript artifact usage, previews, and response bounds.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { findExistingTranscriptPath } from "./session-transcript-archive-reader.js";
import {
  createSessionTranscriptUsageAccumulator,
  type SessionTranscriptUsageSnapshot,
} from "./session-transcript-derived-readers.js";
import { isOversizedTranscriptLine } from "./session-transcript-record-parser.js";

export type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";

export { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
  byteLength: (item: T) => number = jsonUtf8Bytes,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map(byteLength);
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= expectDefined(parts[start], "parts entry at start") + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

export async function readLatestSessionUsageFromTranscriptFileAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
  if (!filePath) {
    return null;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      return null;
    }
    const usageAccumulator = createSessionTranscriptUsageAccumulator("artifact");
    for await (const line of streamSessionTranscriptLines(filePath)) {
      if (isOversizedTranscriptLine(line)) {
        continue;
      }
      let normalizedMessage: Record<string, unknown>;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        // Compaction/reset boundary markers carry no message payload; pass them
        // through so the chars estimate only counts the live window after the
        // latest boundary, not the full retained archive.
        if (record.type === "compaction" || record.type === "reset") {
          usageAccumulator.add({ type: record.type });
          continue;
        }
        if (
          !record.message ||
          typeof record.message !== "object" ||
          Array.isArray(record.message)
        ) {
          continue;
        }
        const message = record.message as Record<string, unknown>;
        const usage =
          message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
            ? message.usage
            : record.usage;
        normalizedMessage = {
          ...message,
          ...(typeof message.provider !== "string" && typeof record.provider === "string"
            ? { provider: record.provider }
            : {}),
          ...(typeof message.model !== "string" && typeof record.model === "string"
            ? { model: record.model }
            : {}),
          ...(usage && typeof usage === "object" && !Array.isArray(usage) ? { usage } : {}),
        };
      } catch {
        continue;
      }
      usageAccumulator.add(normalizedMessage);
    }
    return usageAccumulator.finish();
  } catch {
    return null;
  }
}
