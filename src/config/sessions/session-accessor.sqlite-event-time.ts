import { forEachVerifiedSessionColdArchiveEvent } from "./session-cold-storage-codec.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import {
  transcriptEventJsonMayOverlapRange,
  type SessionTranscriptEventTimeRange,
} from "./transcript-event-time.js";

export type SessionTranscriptEventTimeSource =
  | { kind: "include" }
  | { kind: "hot"; overlapsRange: boolean }
  | { kind: "cold"; storePath: string; archive: SessionColdArchive };

export async function sessionTranscriptEventTimeSourceOverlapsRange(
  source: SessionTranscriptEventTimeSource,
  range: SessionTranscriptEventTimeRange,
): Promise<boolean> {
  if (source.kind === "include") {
    return true;
  }
  if (source.kind === "hot") {
    return source.overlapsRange;
  }
  let overlapsRange = false;
  await forEachVerifiedSessionColdArchiveEvent({
    storePath: source.storePath,
    archive: source.archive,
    visitEventJson(eventJson) {
      overlapsRange ||= transcriptEventJsonMayOverlapRange(eventJson, range);
    },
  });
  return overlapsRange;
}
