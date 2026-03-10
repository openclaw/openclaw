export function hasAllowFromEntries(list?: Array<string | number>) {
  return (
    Array.isArray(list) && list.map((value) => String(value).trim()).filter(Boolean).length > 0
  );
}
