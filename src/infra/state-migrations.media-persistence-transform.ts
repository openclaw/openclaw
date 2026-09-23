import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { canonicalizePersistedUserMessageMedia } from "../media/media-facts.js";

export function transformTranscriptEvent(event: TranscriptEvent): {
  changed: boolean;
  event: TranscriptEvent;
} {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return { changed: false, event };
  }
  const canonical = canonicalizePersistedUserMessageMedia(event.message);
  return canonical.changed
    ? { changed: true, event: { ...event, message: canonical.message } }
    : { changed: false, event };
}

export function parseTranscriptEvent(raw: string, owner: string): TranscriptEvent {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner} contains invalid transcript JSON: ${String(error)}`, {
      cause: error,
    });
  }
}

export function eventIdentity(event: TranscriptEvent): string {
  if (!isRecord(event)) {
    return JSON.stringify({ id: null, parentId: null, type: null });
  }
  return JSON.stringify({
    id: typeof event.id === "string" ? event.id : null,
    parentId: typeof event.parentId === "string" ? event.parentId : null,
    type: typeof event.type === "string" ? event.type : null,
  });
}

export function assertEventIdentitiesUnchanged(
  before: readonly TranscriptEvent[],
  after: readonly TranscriptEvent[],
  owner: string,
): void {
  if (before.length !== after.length) {
    throw new Error(`${owner} event count changed during media migration`);
  }
  for (let index = 0; index < before.length; index += 1) {
    if (eventIdentity(before[index]) !== eventIdentity(after[index])) {
      throw new Error(`${owner} event identity changed at index ${index}`);
    }
  }
}

export function parseArchiveContent(content: string, filePath: string): TranscriptEvent[] {
  if (content === "") {
    return [];
  }
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return lines.map((line, index) => {
    if (!line) {
      throw new Error(`${filePath} contains a blank JSONL record at line ${index + 1}`);
    }
    return parseTranscriptEvent(line, `${filePath}:${index + 1}`);
  });
}

function serializeArchiveEvents(
  events: readonly TranscriptEvent[],
  trailingNewline: boolean,
): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function transformMediaArchiveContent(
  content: string,
  filePath: string,
): { changed: boolean; content: string } {
  let nulTailStart = content.length;
  while (nulTailStart > 0 && content.charCodeAt(nulTailStart - 1) === 0) {
    nulTailStart -= 1;
  }
  const hasTerminalNulSuffix = nulTailStart < content.length;
  if (hasTerminalNulSuffix && nulTailStart === 0) {
    throw new Error(`${filePath} contains no JSONL records before its terminal NUL suffix`);
  }
  // Torn writes may leave only preallocated NUL bytes after complete JSONL records.
  // Recovery stays doctor-owned and reaches the same verified atomic replacement as media repair.
  const recoveredContent = hasTerminalNulSuffix ? content.slice(0, nulTailStart) : content;
  const events = parseArchiveContent(recoveredContent, filePath);
  let mediaChanged = false;
  const transformed = events.map((event) => {
    const result = transformTranscriptEvent(event);
    mediaChanged ||= result.changed;
    return result.event;
  });
  if (!hasTerminalNulSuffix && !mediaChanged) {
    return { changed: false, content };
  }
  assertEventIdentitiesUnchanged(events, transformed, filePath);
  const rewritten = mediaChanged
    ? serializeArchiveEvents(transformed, recoveredContent.endsWith("\n"))
    : recoveredContent;
  return { changed: true, content: rewritten };
}
