/** Private, destination-neutral formatting values. Offsets are UTF-16, half-open. */
export type DictationFormattingMode = "preserve" | "explicit";
export type DictationRange = Readonly<{ start: number; end: number }>;
export type DictationSource = Readonly<{ id: string; revision: number; text: string }>;
export type DictationRun = Readonly<{
  type: "text" | "line-break";
  source: DictationRange;
}>;
export type DictationParagraph = Readonly<{
  type: "paragraph";
  runs: readonly DictationRun[];
  marker?: DictationRange;
}>;
export type DictationListItem = Readonly<{
  runs: readonly DictationRun[];
  children: readonly DictationList[];
  marker: DictationRange;
  ordinal?: number;
}>;
export type DictationList = Readonly<{
  type: "list";
  ordered: boolean;
  items: readonly DictationListItem[];
  marker?: DictationRange;
  endMarker?: DictationRange;
}>;
export type DictationBlock = DictationParagraph | DictationList;
export type DictationMarkerReason =
  | "paragraph-break"
  | "line-break"
  | "bullet"
  | "next-item"
  | "numbered-item"
  | "list-start"
  | "nested-list"
  | "list-end";
export type DictationConsumedMarker = Readonly<{
  source: DictationRange;
  reason: DictationMarkerReason;
  ordinal?: number;
}>;
export type DictationMarkerCandidate = Readonly<{
  source: DictationRange;
  reason: "paragraph-break" | "line-break";
}>;
export type DictationDocument = Readonly<{
  version: 1;
  mode: DictationFormattingMode;
  source: DictationSource;
  protectedRanges: readonly DictationRange[];
  blocks: readonly DictationBlock[];
  consumedMarkers: readonly DictationConsumedMarker[];
  confirmedMarkers: readonly DictationRange[];
}>;
export type DictationDocumentCounts = Readonly<{ blocks: number; items: number; depth: number }>;
export type DictationFormattingResult = Readonly<{
  status: "preserved" | "formatted" | "needs-review" | "raw-fallback";
  originalText: string;
  plainText: string;
  markdown: string;
  html: string;
  document?: DictationDocument;
  reason?: string;
  counts: DictationDocumentCounts;
  candidates: readonly DictationMarkerCandidate[];
}>;
export type PreparedDictationFormatting = DictationFormattingResult;
export type DictationFormattingOptions = Readonly<{
  sourceId?: string;
  sourceRevision?: number;
  protectedRanges?: readonly DictationRange[];
  locale?: string;
  confirmedMarkers?: readonly DictationRange[];
}>;

// Provisional resource ceilings, qualified separately from native target support.
export const DICTATION_FORMATTING_LIMITS = Object.freeze({
  textBytes: 32 * 1024,
  blocks: 100,
  items: 100,
  depth: 3,
  runs: 1_000,
  markers: 500,
  protectedRanges: 512,
  confirmationCandidates: 20,
});
export const DICTATION_MARKDOWN_PROFILE = "commonmark-0.31.2-lists";
export const DICTATION_RICH_PROFILE = "safe-blocks-v1";
