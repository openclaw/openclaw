const replyAppliedMarkers = new WeakMap<object, boolean>();

export function markReplyApplied<T extends object>(value: T, applied: boolean): T {
  replyAppliedMarkers.set(value, applied);
  return value;
}

export function readReplyApplied(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return replyAppliedMarkers.get(value);
}
