// Same-turn media provenance for recent conversation reads: the managed media that trusted tool
// results earlier in a reply's own turn carried. Readers collect it inside the snapshot they
// select from, so a later tool result can never be lent to an earlier reply.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractToolResultMediaArtifact,
  filterPersistedToolResultMediaUrls,
} from "../../agents/embedded-agent-tool-media.js";
import { MAX_GROUNDING_PATHS } from "../../media/media-grounding-limits.js";

// How many earlier rows of its own turn one assistant entry keeps.
const MAX_SAME_TURN_ROWS = 1_000;

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

type TrackedTurn = {
  entry: { turnMediaReferences?: string[] };
  preceding: (Record<string, unknown> | undefined)[];
};

/**
 * Walks one snapshot newest first: `observe` every row before selecting from it, `track` each
 * selected assistant entry, and keep reading while `collecting()` so the oldest tracked entry
 * reaches the start of its turn. A user row closes every open turn. `finish` sets each tracked
 * entry's `turnMediaReferences`, oldest result first and bounded like write-time authorization.
 */
export function createTurnMediaReferenceCollector() {
  const tracked: TrackedTurn[] = [];
  let open: TrackedTurn[] = [];
  return {
    observe(event: unknown): void {
      const message = readTranscriptEventMessage(event);
      if (message?.role === "user") {
        open = [];
        return;
      }
      for (const turn of open) {
        turn.preceding.push(message);
      }
      open = open.filter(({ preceding }) => preceding.length < MAX_SAME_TURN_ROWS);
    },
    track(entry: TrackedTurn["entry"]): void {
      const turn: TrackedTurn = { entry, preceding: [] };
      tracked.push(turn);
      open.push(turn);
    },
    collecting: (): boolean => open.length > 0,
    finish(): void {
      for (const { entry, preceding } of tracked) {
        entry.turnMediaReferences = sameTurnReferences(preceding.toReversed());
      }
    },
  };
}
