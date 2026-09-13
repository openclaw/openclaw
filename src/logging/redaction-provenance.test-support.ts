// Test support for redaction provenance assertions (#142821).
//
// Persisted transcripts are JSON: the marker's escape byte is serialized as its `\u00xx`
// escape sequence, so a comparison against raw file text needs the serialized form.

/** Renders one marker the way it appears inside serialized JSON text. */
export function serializeRedactionMarker(marker: string): string {
  const serialized = JSON.stringify(marker);
  return serialized.slice(1, -1);
}
