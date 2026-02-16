export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return [Array.from(items)];
  }
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}
