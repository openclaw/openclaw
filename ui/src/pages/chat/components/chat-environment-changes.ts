export function hasEnvironmentTextChanges(result?: { additions?: number; deletions?: number }) {
  return (result?.additions ?? 0) > 0 || (result?.deletions ?? 0) > 0;
}
