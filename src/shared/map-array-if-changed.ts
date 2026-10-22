/** Preserve the source array when every mapped entry is unchanged. */
export function mapArrayIfChanged<T>(values: T[], map: (value: T) => T): T[] {
  let changed = false;
  const next = values.map((value) => {
    const mapped = map(value);
    changed ||= mapped !== value;
    return mapped;
  });
  return changed ? next : values;
}
