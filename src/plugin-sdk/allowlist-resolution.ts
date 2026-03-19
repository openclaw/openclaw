export type BasicAllowlistResolutionEntry = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
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

/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
export async function mapAllowlistResolutionInputs<T>(params: {
  inputs: string[];
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]> {
  const results: T[] = [];
  for (const input of params.inputs) {
    results.push(await params.mapInput(input));
  }
  return results;
}
