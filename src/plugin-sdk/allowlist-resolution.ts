export type BasicAllowlistResolutionEntry = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

export function mapBasicAllowlistResolutionEntries(
  entries: BasicAllowlistResolutionEntry[],
): BasicAllowlistResolutionEntry[] {
  return entries.map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id,
    name: entry.name,
    note: entry.note,
  }));
}
