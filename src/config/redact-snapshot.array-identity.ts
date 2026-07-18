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
 * restore redacted values from. Identity-keyed arrays match by `id`; unmatched,
 * renamed, or duplicated ids resolve to `undefined` so redacted placeholders
 * fail closed. Non-identity arrays resolve positionally, preserving existing
 * behaviour.
 *
 * Whether the array is identity-keyed is decided from the authoritative original
 * array, so a client cannot flip the whole array to positional by crafting an
 * `id`. (A client can still send a bare value for one row, which resolves that
 * row positionally — unchanged from before this indirection.) `visibleIdOf`
 * returns an original item's id
 * as the client receives it — the redactor's own output, so redaction rules are
 * never re-implemented here. Ids that redact away collapse to one sentinel key,
 * which reads as duplicate and keeps the array positional (unchanged saves are
 * not rejected). Otherwise identity applies per row only to object rows that
 * carry an id: a bare value (a whole-item redaction sentinel, or a sensitive
 * string array element) has no identity and restores positionally, exactly as
 * before; an object row missing or duplicating an `id` resolves to no original
 * so its redacted fields fail closed.
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
