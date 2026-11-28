import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Infers the largest `<number>b` parameter-size token from a model id or display name. */
export function inferParamBFromIdOrName(text: string): number | null {
  const raw = normalizeLowercaseStringOrEmpty(text);
  // Trailing boundary is a lookahead so two adjacent `<num>b` tokens sharing one delimiter (e.g.
  // "8b 70b" / "8b-70b") both match; a consuming boundary ate the delimiter and skipped the second.
  // A<size>B denotes active parameters, so it cannot establish the total size.
  const matches = raw.matchAll(
    /(?:^|[^a-z0-9])[b-z]?(\d+(?:\.\d+)?)b(?:[-_\s]+(\d+)e)?(?=[^a-z0-9]|$)/g,
  );
  let best: number | null = null;
  for (const match of matches) {
    // Skip active-size expert tags, retaining any independently stated total size.
    if (match[2]) {
      continue;
    }
    const numRaw = match[1];
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    if (best === null || value > best) {
      best = value;
    }
  }
  return best;
}
