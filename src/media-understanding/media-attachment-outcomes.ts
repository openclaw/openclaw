import type { MediaAttachmentDisposition, MediaUnderstandingCapability } from "./types.js";

const MAX_SKIPPED_FILE_MARKERS = 5;
const MAX_FAILURE_REASON_CHARS = 160;

/** Keeps the marker one line and bounded even when a provider body is long. */
function renderFailureReason(reason: string | undefined): string {
  const trimmed = reason?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  const bounded =
    trimmed.length <= MAX_FAILURE_REASON_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_FAILURE_REASON_CHARS - 1)}…`;
  return `: ${bounded}`;
}

// Reason-neutral because the shared overflow can mix file and media outcomes.
function renderSkippedFileOverflowSummary(count: number): string {
  return `[${count} more attachment${count === 1 ? "" : "s"} skipped]`;
}

export function renderMediaAttachmentDisposition(
  capability: MediaUnderstandingCapability,
  disposition: MediaAttachmentDisposition,
): string | null {
  const label = `${capability[0]?.toUpperCase()}${capability.slice(1)}`;
  switch (disposition.kind) {
    case "handled":
    case "handed-to-native-vision":
      return null;
    case "not-selected":
      return `[${label} attachment not processed: attachment limit reached]`;
    case "capability-disabled":
      return `[${label} attachment not analyzed: ${capability} understanding is disabled]`;
    case "no-model":
      return `[${label} attachment not analyzed: no ${capability}-understanding model is configured]`;
    case "scope-denied":
      return `[${label} attachment not analyzed in this chat]`;
    case "failed":
      return `[${label} attachment could not be analyzed${renderFailureReason(disposition.reason)}]`;
    default:
      return disposition satisfies never;
  }
}

export type AttachmentContextBlock = { text: string; consumesMarkerBudget: boolean };

export function applyAttachmentMarkerBudget(blocks: AttachmentContextBlock[]): string[] {
  const rendered: string[] = [];
  let markers = 0;
  let overflow = 0;
  for (const block of blocks) {
    if (block.consumesMarkerBudget && markers >= MAX_SKIPPED_FILE_MARKERS) {
      overflow += 1;
      continue;
    }
    markers += Number(block.consumesMarkerBudget);
    rendered.push(block.text);
  }
  return overflow > 0 ? [...rendered, renderSkippedFileOverflowSummary(overflow)] : rendered;
}
