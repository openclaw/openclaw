import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "./types.js";

type EntryView = Partial<Omit<SessionEntry, "lifecycleRevision" | "archivedAt">> & {
  lifecycleRevision?: string | null;
  archivedAt?: number | null;
};

/** A detached read precondition, not an address or a live transcript writer lease. */
export function captureSessionEntryView(
  entry: EntryView | undefined,
  fields: readonly (keyof EntryView)[],
) {
  const selectedFields = [...fields];
  const read = (value: EntryView | undefined) =>
    value &&
    selectedFields.map((field) =>
      field === "lifecycleRevision" || field === "archivedAt"
        ? (value[field] ?? null)
        : value[field],
    );
  const expected = structuredClone(read(entry));
  return Object.freeze({
    matches: (current: EntryView | undefined) => isDeepStrictEqual(expected, read(current)),
  });
}
