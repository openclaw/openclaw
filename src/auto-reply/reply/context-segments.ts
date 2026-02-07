/**
 * Structured context segments for body assembly.
 *
 * Replaces ad-hoc string concatenation with typed segments that are
 * rendered to a string at the last moment before agent invocation.
 */

export type SegmentKind =
  | "media-note"
  | "media-hint"
  | "warroom-briefing"
  | "narrative-guide"
  | "recall"
  | "thread-starter"
  | "system-event"
  | "abort-hint"
  | "message-body"
  | "message-id-hint"
  | "untrusted-context";

export type ContextSegment = {
  readonly kind: SegmentKind;
  /** Mutable — think-level extraction may strip the leading token from message-body. */
  content: string;
};

const MEDIA_KINDS = new Set<SegmentKind>(["media-note", "media-hint"]);

/**
 * Determine the separator between two adjacent segments.
 *
 * Rules (matching legacy string-concatenation behavior):
 * - media-note / media-hint use "\n" to each other and to the next segment
 * - message-id-hint bonds to its predecessor with "\n"
 * - all other adjacent main-zone segments use "\n\n"
 */
function separatorAfter(current: SegmentKind, next: SegmentKind): string {
  if (next === "message-id-hint") return "\n";
  if (MEDIA_KINDS.has(current)) return "\n";
  return "\n\n";
}

/**
 * Render an ordered array of segments into a single prompt string.
 *
 * The output is byte-identical to the legacy string-concatenation chain
 * in get-reply-run.ts when segments are provided in canonical order.
 */
export function renderSegments(segments: readonly ContextSegment[]): string {
  const nonEmpty = segments.filter((s) => Boolean(s.content));
  if (nonEmpty.length === 0) return "";

  const hasMedia = nonEmpty.some((s) => MEDIA_KINDS.has(s.kind));

  let result = nonEmpty[0].content;
  for (let i = 1; i < nonEmpty.length; i++) {
    result += separatorAfter(nonEmpty[i - 1].kind, nonEmpty[i].kind) + nonEmpty[i].content;
  }

  // Legacy behavior: .trim() only when media segments are present
  return hasMedia ? result.trim() : result;
}

/** Find the first segment of a given kind. */
export function findSegment(
  segments: ContextSegment[],
  kind: SegmentKind,
): ContextSegment | undefined {
  return segments.find((s) => s.kind === kind);
}
