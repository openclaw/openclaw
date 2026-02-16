export function normalizeAllowList(list?: Array<string | number> | null): string[] {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

export function stripChannelPrefix(value: string, pattern: RegExp): string {
  return value.replace(pattern, "");
}
