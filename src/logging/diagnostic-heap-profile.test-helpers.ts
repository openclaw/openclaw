/** Named, retained allocations for the native inspector contract test. */
export function allocateHeapProfileWorkload() {
  const retained: number[][] = [];
  for (let index = 0; index < 2_048; index++) {
    const row: number[] = [];
    for (let column = 0; column < 128; column++) {
      row.push(index);
    }
    retained.push(row);
  }
  return retained;
}

/** Allocate and drop 200 MiB in bounded batches before the final collection. */
export function allocateDroppedHeapProfileWorkload() {
  const rows: number[][] = [];
  for (let index = 0; index < 200; index++) {
    const row: number[] = [];
    // Resizing keeps the allocation in this JavaScript frame.
    row.length = 131_072;
    row.fill(index);
    rows.push(row);
    if (rows.length === 10) {
      rows.length = 0;
    }
  }
}
