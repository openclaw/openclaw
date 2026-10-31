/** MiB-sized backing stores keep retained samples attributed to this frame. */
export function allocateHeapProfileWorkload() {
  const retained: number[][] = [];
  for (let index = 0; index < 8; index++) {
    const row: number[] = [];
    row.length = 131_072;
    row.fill(index);
    retained.push(row);
  }
  return retained;
}

/** Allocate and drop MiB-sized rows in bounded batches before the final collection. */
export function allocateDroppedHeapProfileWorkload(rowCount = 200) {
  const rows: number[][] = [];
  for (let index = 0; index < rowCount; index++) {
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
