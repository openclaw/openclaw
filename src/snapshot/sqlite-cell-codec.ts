export function encodeSqliteValue(value: unknown): unknown {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Git backup cannot encode a non-finite SQLite REAL value.");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : { $int: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { $hex: Buffer.from(value).toString("hex") };
  }
  throw new Error(`Git backup cannot encode SQLite value type ${typeof value}.`);
}

export function escapedSqliteText(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN json_quote(${column}) ELSE ${column} END`;
}
