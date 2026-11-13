import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptMaintenanceCheckpoint } from "./session-transcript-hydration.types.js";
import { projectSessionTranscriptReportFacts } from "./session-transcript-report-facts.js";

/** Only a direct append chain can extend a replay without rebuilding logical branch navigation. */
export function selectTranscriptMaintenanceSuffix(
  rows: Iterable<{ event: unknown; bytes: number }>,
  checkpoint: SessionTranscriptMaintenanceCheckpoint,
  leafEntryId: string | null,
  customType: string,
): Record<string, unknown>[] | undefined {
  let parent = checkpoint.leafEntryId;
  let count = 0;
  let bytes = 0;
  const events: Record<string, unknown>[] = [];
  for (const row of rows) {
    bytes += row.bytes;
    if (++count > 256 || bytes > 1024 * 1024) {
      return undefined;
    }
    const facts = projectSessionTranscriptReportFacts(row.event);
    if (
      facts.kind !== "canonical" ||
      !facts.hasParentId ||
      facts.entry.parentId !== parent ||
      facts.entry.appendMode === "side" ||
      facts.entry.type === "reset" ||
      facts.entry.type === "label"
    ) {
      return undefined;
    }
    parent = facts.entry.id;
    const event = asOptionalRecord(row.event)!;
    if (facts.entry.type === "custom" && event.customType === customType) {
      events.push(event);
    }
  }
  return parent === leafEntryId ? events : undefined;
}
