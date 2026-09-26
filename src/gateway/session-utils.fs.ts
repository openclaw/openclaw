// Transcript artifact usage, previews, and response bounds.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
        const record = asOptionalRecord(JSON.parse(line));
        const message = asOptionalRecord(record?.message);
        if (!record || !message) {
          continue;
        }
        const usage = asOptionalRecord(message.usage) ?? asOptionalRecord(record.usage);
        normalizedMessage = {
          ...message,
          ...(typeof message.provider !== "string" && typeof record.provider === "string"
            ? { provider: record.provider }
            : {}),
          ...(typeof message.model !== "string" && typeof record.model === "string"
            ? { model: record.model }
            : {}),
          ...(usage ? { usage } : {}),
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
