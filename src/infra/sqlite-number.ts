/** Converts a SQLite number or bigint column into a JavaScript number.
 *  Returns undefined when the value is null, non-numeric, or a bigint that
 *  exceeds Number.MAX_SAFE_INTEGER (2^53-1) where Number() would silently
 *  lose precision or return Infinity. */
export function normalizeSqliteNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    if (value > Number.MAX_SAFE_INTEGER || value < -Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}
