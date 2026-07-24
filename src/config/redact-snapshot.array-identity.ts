// Identity resolution for restoring redacted values inside config arrays.
//
// Redacted snapshots replace sensitive values with a sentinel and restore the
// real value from the original config when a client saves an edited snapshot.
// For object arrays the restore used to follow array position, so removing or
// reordering a row could restore a different row's original value into a
// retained row. When every original item carries a unique, non-empty string
// `id`, this module matches edited items to their original by that identity
// instead, and refuses to resolve ambiguous edits (renamed, inserted, or
// duplicated ids) so redacted placeholders fail closed rather than inheriting a
// neighbouring item's value. Arrays without a stable id keep positional matching.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Returns an item's stable identity when it is an object with a non-empty string `id`. */
function stableStringId(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const id = item.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Indexes original items by the id the client actually receives, i.e. the id as
 * it appears after redaction (`visibleIdOf`). Returns null unless every item
 * yields a unique, non-empty visible id, so bare-value arrays, arrays with
 * missing or duplicate ids, and arrays whose ids redact to the same sentinel all
 * stay positional.
 */
function buildStableIdIdentityIndex(
  originalArray: unknown[],
  visibleIdOf: (item: unknown) => string | undefined,
): Map<string, unknown> | null {
  if (originalArray.length === 0) {
    return null;
  }
  const index = new Map<string, unknown>();
  for (const item of originalArray) {
    const visibleId = visibleIdOf(item);
    if (visibleId === undefined || index.has(visibleId)) {
      return null;
    }
    index.set(visibleId, item);
  }
  return index;
}

/** Collects ids that appear more than once, which are ambiguous to restore. */
function findDuplicateStableIds(items: unknown[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const id = stableStringId(item);
    if (id === undefined) {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return duplicates;
}

interface RedactedArrayOriginalResolver {
  /** True when the original array is unambiguously keyed by a unique string `id`. */
  readonly identityKeyed: boolean;
  /** Resolves the original item that `incomingItem` may restore redacted values from. */
  resolve(incomingItem: unknown, index: number): unknown;
}

/**
 * Builds a resolver mapping each edited array item to the original item it may
 * restore redacted values from.
 *
 * An identity lookup is built only when the authoritative original array yields a
 * unique, non-empty, client-visible id for every item. `visibleIdOf` reports each
 * id as the redactor renders it, so redaction rules are never re-implemented
 * here, and ids that redact away collapse to a single key and read as ambiguous.
 * When identity cannot be established that way, the array resolves positionally
 * and the caller's existing behaviour is untouched.
 *
 * With identity established, an object row matches its original by id, while a
 * row whose id is missing, duplicated or absent from the original resolves to no
 * original so its redacted placeholders fail closed rather than inheriting
 * another row's value; a bare value carries no id and resolves positionally. The
 * resolver only selects which original a row may draw from — values the client
 * submitted explicitly are never replaced.
 */
export function createRedactedArrayOriginalResolver(
  originalArray: unknown[],
  incomingArray: unknown[],
  visibleIdOf: (item: unknown) => string | undefined,
): RedactedArrayOriginalResolver {
  const identityIndex = buildStableIdIdentityIndex(originalArray, visibleIdOf);
  if (!identityIndex) {
    return {
      identityKeyed: false,
      resolve: (_incomingItem, index) => originalArray[index],
    };
  }
  const duplicateIncomingIds = findDuplicateStableIds(incomingArray);
  return {
    identityKeyed: true,
    resolve: (incomingItem, index) => {
      if (!isRecord(incomingItem)) {
        return originalArray[index];
      }
      const id = stableStringId(incomingItem);
      if (id === undefined || duplicateIncomingIds.has(id)) {
        return undefined;
      }
      return identityIndex.get(id);
    },
  };
}
