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
