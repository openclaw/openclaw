import * as records from "./session-row-projection-record.js";

type Acquisition = Parameters<typeof records.acquireSessionRowEntry>[0];

/** Install accepted facts that can change independently of entry metadata. */
export function createSessionRowEntryAcquirer(
  owner: Omit<Acquisition, "row" | "storedEntry" | "cfg" | "context"> & {
    rows: ReadonlyMap<string, records.Row>;
    prepare: (entry: records.Row["storedEntry"]) => Pick<Acquisition, "cfg" | "context">;
  },
) {
  const { rows, prepare, ...acquisition } = owner;
  return (row: records.Row, storedEntry: records.Row["storedEntry"]) => {
    const next = records.acquireSessionRowEntry({
      ...acquisition,
      ...prepare(storedEntry),
      row,
      storedEntry,
    });
    if (next === row && rows.get(records.identity(row)) !== row) {
      acquisition.put(row);
    }
    return next;
  };
}
