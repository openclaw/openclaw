// Model-visible redaction presentation: a self-describing marker, an operator notice, and the
// scoped active-marker state that keeps the low-level mask helpers (maskToken, maskSecretValue,
// literal placeholders) in sync without threading an option through every call site.
// Diagnostic log surfaces keep the compact `***` marker; only model-visible surfaces switch to the
// self-describing marker while a redaction call is in flight.

/** Marker written for masked spans on model-visible surfaces. */
export const MODEL_VISIBLE_REDACT_MARKER = "⟦redacted⟧";

/** Appended to model-visible tool content when redaction changed it, so the tool call itself
 * carries the notification (a user reading the transcript or the model reading the result both
 * see it). */
export const MODEL_VISIBLE_REDACTION_NOTICE =
  "\n\n[openclaw] Note: sensitive value(s) in this content were redacted by the secret redactor before it reached the model.";

// Stable prefix used to recognize an already-redacted model-visible payload by content.
const MODEL_VISIBLE_REDACTION_NOTICE_PREFIX = "[openclaw] Note: sensitive value(s)";

let activeRedactMarker: string | undefined;

/** Current mask replacement; defaults to the compact `***` marker outside model-visible calls. */
export function maskReplacement(): string {
  return activeRedactMarker ?? "***";
}

/** Runs `fn` with an explicit marker active for the low-level mask helpers. */
export function withRedactMarker<T>(marker: string | undefined, fn: () => T): T {
  if (marker === undefined) {
    return fn();
  }
  const previous = activeRedactMarker;
  activeRedactMarker = marker;
  try {
    return fn();
  } finally {
    activeRedactMarker = previous;
  }
}

/** Runs `fn` with the model-visible marker active. */
export function withModelVisibleMarker<T>(fn: () => T): T {
  return withRedactMarker(MODEL_VISIBLE_REDACT_MARKER, fn);
}

/** Appends the redaction notice when model-visible redaction changed the content. */
export function appendModelVisibleRedactionNotice(original: string, redacted: string): string {
  return redacted === original ? redacted : `${redacted}${MODEL_VISIBLE_REDACTION_NOTICE}`;
}

/** Whether a value (recursively) carries a model-visible redaction marker or notice. */
export function containsModelVisibleRedaction(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") {
    return (
      value.includes(MODEL_VISIBLE_REDACT_MARKER) ||
      value.includes(MODEL_VISIBLE_REDACTION_NOTICE_PREFIX)
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsModelVisibleRedaction(entry, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsModelVisibleRedaction(entry, seen),
    );
  }
  return false;
}
