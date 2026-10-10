// Grounds recent conversation rows before replay: same-turn tool-result media provenance,
// managed-media grounding of assistant text, and the channel replay byte budget.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractToolResultMediaArtifact,
  filterPersistedToolResultMediaUrls,
} from "../../agents/embedded-agent-tool-media.js";
import { MAX_GROUNDING_PATHS } from "../../media/media-grounding-limits.js";
import {
  findUnverifiedJoinedMediaSpellings,
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGroundingRoot,
} from "../../media/media-reference.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import type { SessionTranscriptReadScope, TranscriptEvent } from "./session-accessor.js";
import type { SessionTranscriptBoundedMessageTailPage } from "./session-accessor.sqlite-projection-read.js";
import {
  invalidateUngroundedMediaPrefixes,
  type JoinedMediaSpellings,
} from "./transcript-grounding.js";

const MAX_RECENT_TRANSCRIPT_ENTRY_BYTES = 32 * 1024,
  MAX_RECENT_TRANSCRIPT_WINDOW_BYTES = 128 * 1024;
// Messages per history page, and how many earlier rows of its own turn one assistant entry keeps.
const PAGE_MESSAGES = 250,
  MAX_SAME_TURN_ROWS = 1_000;
// Reads that find the transcript changed between pages before replay stops trusting provenance.
const MAX_SNAPSHOT_ATTEMPTS = 3;

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

function sameTurnReferences(preceding: readonly (Record<string, unknown> | undefined)[]) {
  const references: string[] = [];
  for (const message of preceding) {
    if (references.length >= MAX_GROUNDING_PATHS) {
      break;
    }
    if (message) {
      references.push(
        ...readTurnGroundedMediaPaths(message, MAX_GROUNDING_PATHS - references.length),
      );
    }
  }
  return references;
}

type PageSnapshot = SessionTranscriptBoundedMessageTailPage["snapshot"];

const sameSnapshot = (left: PageSnapshot, right: PageSnapshot) =>
  left.generation === right.generation &&
  left.indexedSeq === right.indexedSeq &&
  left.boundarySeq === right.boundarySeq;

/**
 * The newest `limit` entries `select` accepts, newest first, each assistant entry with the media
 * its own turn's tool results carried. Pages come through the history reader, off the Gateway
 * thread and through the incognito actor that holds a session. Provenance must come from one
 * transcript state: offsets count from the end, so a write between pages shifts the next page
 * onto rows already read and could lend a later tool result to an earlier reply. A page from
 * another snapshot restarts the read; if the transcript keeps changing, every entry is returned
 * with no references, so replay redacts its managed media instead of guessing.
 */
export async function selectRecentConversationRows<T extends ConversationEntry>(
  scope: SessionTranscriptReadScope,
  limit: number,
  select: (event: TranscriptEvent) => T | undefined,
): Promise<RecentConversationRow<T>[]> {
  const { readSessionTranscriptBoundedMessageTailPageAsync } =
    await import("../../gateway/session-transcript-readers.js");
  type Selected = { entry: T; preceding?: (Record<string, unknown> | undefined)[] };
  for (let attempt = 1; ; attempt += 1) {
    const selected: Selected[] = [];
    let pending: Selected[] = [];
    let snapshot: PageSnapshot | undefined;
    let changed = false;
    for (let offset = 0; selected.length < limit || pending.length > 0;) {
      const page = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
        maxMessages: PAGE_MESSAGES,
        // Every message counts toward the page; none is dropped for its size.
        maxBytes: Number.MAX_SAFE_INTEGER,
        offset,
      });
      if (snapshot && !sameSnapshot(snapshot, page.snapshot)) {
        changed = true;
        // The last attempt reads on, as replay did before, and drops the provenance instead.
        if (attempt < MAX_SNAPSHOT_ATTEMPTS) {
          break;
        }
      }
      snapshot = page.snapshot;
      for (const row of page.events.toReversed()) {
        const message = readTranscriptEventMessage(row.event);
        if (message?.role === "user") {
          pending = [];
        } else {
          for (const assistant of pending) {
            assistant.preceding?.push(message);
          }
          pending = pending.filter(
            ({ preceding }) => (preceding?.length ?? 0) < MAX_SAME_TURN_ROWS,
          );
        }
        const entry = selected.length < limit ? select(row.event) : undefined;
        if (entry) {
          const picked: Selected =
            entry.role === "assistant" ? { entry, preceding: [] } : { entry };
          selected.push(picked);
          if (picked.preceding) {
            pending.push(picked);
          }
        }
        if (selected.length >= limit && pending.length === 0) {
          break;
        }
      }
      offset += page.scannedMessages;
      if (page.scannedMessages === 0 || offset >= page.totalMessages) {
        break;
      }
    }
    if (changed && attempt < MAX_SNAPSHOT_ATTEMPTS) {
      continue;
    }
    return selected.map(({ entry, preceding }) => ({
      entry,
      references: changed || !preceding ? [] : sameTurnReferences(preceding.toReversed()),
    }));
  }
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
      const joins: JoinedMediaSpellings = { found: new Set() };
      const grounded = invalidateUngroundedMediaPrefixes(entry.text, grounding, joins);
      // Only a recorded joined spelling needs the store, and only one it finds needs a rescan.
      const unverified = joins.found.size
        ? await findUnverifiedJoinedMediaSpellings(groundingRoot, grounding, joins.found)
        : undefined;
      entry.text = unverified?.size
        ? invalidateUngroundedMediaPrefixes(entry.text, grounding, { found: new Set(), unverified })
        : grounded;
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
