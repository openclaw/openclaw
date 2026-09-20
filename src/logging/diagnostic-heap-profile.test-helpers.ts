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
