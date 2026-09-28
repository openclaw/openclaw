export type LiveTextProjectionText = { snapshot: string; delta: string };

export function isLiveTextAppend(
  previous: string | undefined,
  next: LiveTextProjectionText,
): boolean {
  return (
    previous !== undefined &&
    next.snapshot.length === previous.length + next.delta.length &&
    next.snapshot.startsWith(previous) &&
    next.snapshot.endsWith(next.delta)
  );
}
