import { isRecord } from "@openclaw/normalization-core/record-coerce";

type ComposerSpan = { start: number; end: number };

/** Stored identity spans are ordered, nonempty UTF-16 ranges in this exact draft. */
export function isComposerSpan(
  value: unknown,
  previousEnd: number,
  textLength: number,
): value is Record<string, unknown> & ComposerSpan {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    Number.isSafeInteger(value.start) &&
    typeof value.end === "number" &&
    Number.isSafeInteger(value.end) &&
    value.start >= previousEnd &&
    value.end > value.start &&
    value.end <= textLength
  );
}

/** For ambiguous edits to repeated text, discard the union of possibly touched spans. */
export function mapComposerSpans<T extends ComposerSpan>(
  previous: string,
  next: string,
  spans: readonly T[],
  exact?: ComposerSpan,
  labelContinuation?: RegExp,
): T[] {
  const delta = next.length - previous.length;
  let start = 0;
  let end = previous.length;
  if (exact) {
    ({ start, end } = exact);
  } else {
    const shared = Math.min(previous.length, next.length);
    while (start < shared && previous[start] === next[start]) {
      start += 1;
    }
    let suffix = 0;
    while (suffix < shared && previous[end - suffix - 1] === next[next.length - suffix - 1]) {
      suffix += 1;
    }
    end -= suffix;
    if (start + suffix > shared) {
      end = start + Math.max(0, -delta);
      start = shared - suffix;
    }
  }
  return spans.flatMap((span) => {
    if (span.end <= start) {
      return span.end === start && labelContinuation?.test(next[start] ?? "") ? [] : [span];
    }
    return span.start >= end ? [{ ...span, start: span.start + delta, end: span.end + delta }] : [];
  });
}
