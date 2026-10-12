import type { SessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import type { SessionEntrySnapshot } from "./session-entry-snapshots.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Exact persisted facts retained by the synchronous transaction that wrote them. */
export type SessionEntryWritePostimage = {
  changed: boolean;
  entry: SessionEntry;
  row: ResolvedSessionEntryRow["row"];
  window: SessionEntryWindowRow;
  transcriptWatermark?: SessionTranscriptWatermark;
  sideTables: {
    memberIdsJson: string;
    hasBoard: boolean;
  };
};

export type SessionEntryWritePostimages = Map<string, SessionEntryWritePostimage>;

export function createSessionEntryWriteRow(params: {
  previous: ResolvedSessionEntryRow["row"] | undefined;
  node: ResolvedSessionEntryRow["row"];
  snapshots: readonly SessionEntrySnapshot[];
  snapshotsChanged: boolean;
  window: SessionEntryWindowRow;
}): ResolvedSessionEntryRow["row"] {
  const snapshotJson = new Map(params.snapshots.map(({ field, valueJson }) => [field, valueJson]));
  return {
    ...params.previous,
    ...params.node,
    ...(params.snapshotsChanged
      ? {
          session_diff_baseline_json: snapshotJson.get("sessionDiffBaseline") ?? null,
          skills_snapshot_json: snapshotJson.get("skillsSnapshot") ?? null,
          system_prompt_report_json: snapshotJson.get("systemPromptReport") ?? null,
        }
      : {}),
    window: params.window,
  };
}
