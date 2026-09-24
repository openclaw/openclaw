// Grounds recent conversation rows before replay: same-turn tool-result media provenance,
// managed-media grounding of assistant text, and the channel replay byte budget.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractToolResultMediaArtifact,
  filterPersistedToolResultMediaUrls,
} from "../../agents/embedded-agent-tool-media.js";
import { MAX_GROUNDING_PATHS } from "../../media/media-grounding-limits.js";
import {
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGroundingRoot,
} from "../../media/media-reference.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import {
  readSessionTranscriptConversationSnapshot,
  type SessionTranscriptReadScope,
  type TranscriptEvent,
} from "./session-accessor.js";
import { DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import { invalidateUngroundedMediaPrefixes } from "./transcript-grounding.js";

const MAX_RECENT_TRANSCRIPT_ENTRY_BYTES = 32 * 1024,
  MAX_RECENT_TRANSCRIPT_WINDOW_BYTES = 128 * 1024;

type ConversationEntry = { role: "user" | "assistant"; text: string };

/** A selected entry and the managed media its turn's trusted tool results carried. */
type RecentConversationRow<T extends ConversationEntry> = { entry: T; references: string[] };

function readTranscriptEventMessage(event: unknown): Record<string, unknown> | undefined {
  return isRecord(event) && event.type === "message" && isRecord(event.message)
    ? event.message
    : undefined;
}

function readTurnGroundedMediaPaths(
  message: Record<string, unknown>,
  maxResults: number,
): string[] {
  if (message.role !== "toolResult") {
    return [];
  }
  const rawToolName = typeof message.toolName === "string" ? message.toolName : undefined;
  // Stable transcripts through v2026.7.1-2 persisted the core image tool under
  // its former name. Normalize only this immutable history; live tools use view_image.
  const toolName = rawToolName === "image" ? "view_image" : rawToolName;
  return (
    extractToolResultMediaArtifact(message, {
      maxMediaCandidates: maxResults,
      maxMediaUrls: maxResults,
      acceptMediaUrl: (mediaUrl) =>
        filterPersistedToolResultMediaUrls(toolName, [mediaUrl], message).length > 0,
    })?.mediaUrls ?? []
  );
}

/**
 * The newest `limit` entries `select` accepts, newest first, each assistant entry with the media
 * its own turn's tool results carried. Synchronous, so a cold-storage restore can retry it.
 */
export function selectRecentConversationRows<T extends ConversationEntry>(
  scope: SessionTranscriptReadScope,
  limit: number,
  select: (event: TranscriptEvent) => T | undefined,
): RecentConversationRow<T>[] {
  const rows: RecentConversationRow<T>[] = [];
  let offset = 0;
  while (rows.length < limit) {
    const maxResults = Math.min(DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES, limit - rows.length);
    const page = readSessionTranscriptConversationSnapshot(scope, {
      offset,
      select: (event) => select(event) !== undefined,
      maxResults,
    });
    for (const row of page.toReversed()) {
      const entry = select(row.event);
      if (!entry) {
        continue;
      }
      const references: string[] = [];
      if (entry.role === "assistant") {
        for (const preceding of row.precedingSameTurn) {
          if (references.length >= MAX_GROUNDING_PATHS) {
            break;
          }
          const message = readTranscriptEventMessage(preceding.event);
          if (message) {
            references.push(
              ...readTurnGroundedMediaPaths(message, MAX_GROUNDING_PATHS - references.length),
            );
          }
        }
      }
      rows.push({ entry, references });
      if (rows.length >= limit) {
        break;
      }
    }
    if (page.length < maxResults) {
      break;
    }
    offset += page.length;
  }
  return rows;
}

/**
 * Oldest first, with unverified managed media removed from assistant text. `boundReplayBytes`
 * is channel replay's budget, applied after grounding: 32 KiB per entry and 128 KiB per read.
 */
export async function groundRecentConversationRows<T extends ConversationEntry>(
  rows: readonly RecentConversationRow<T>[],
  options: { limit: number; boundReplayBytes: boolean },
): Promise<T[]> {
  let groundingRoot: ManagedMediaGroundingRoot | undefined;
  const selected: T[] = [];
  let remainingBytes = MAX_RECENT_TRANSCRIPT_WINDOW_BYTES;
  for (const { entry, references } of rows) {
    if (options.boundReplayBytes && remainingBytes <= 0) {
      break;
    }
    if (entry.role === "assistant") {
      groundingRoot ??= await prepareManagedMediaGroundingRoot();
      const grounding = await prepareManagedMediaGrounding(groundingRoot, references);
      entry.text = invalidateUngroundedMediaPrefixes(entry.text, grounding);
    }
    let text = entry.text;
    if (options.boundReplayBytes) {
      text = truncateUtf8Prefix(text, Math.min(remainingBytes, MAX_RECENT_TRANSCRIPT_ENTRY_BYTES));
      remainingBytes -= Buffer.byteLength(text);
    }
    if (text) {
      selected.push({ ...entry, text });
      if (selected.length >= options.limit) {
        break;
      }
    }
  }
  return selected.toReversed();
}
