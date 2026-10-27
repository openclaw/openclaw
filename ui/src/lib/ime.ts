const compositionEndTimes = new WeakMap<EventTarget, number>();

export function recordCompositionEnd(event: CompositionEvent): void {
  if (event.target) {
    compositionEndTimes.set(event.target, event.timeStamp);
  }
}

export function clearCompositionEnd(event: Event): void {
  if (event.target) {
    compositionEndTimes.delete(event.target);
  }
}

export function isComposingKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) {
    return true;
  }
  if (event.key !== "Enter") {
    clearCompositionEnd(event);
    return false;
  }
  const endedAt = event.target ? compositionEndTimes.get(event.target) : undefined;
  // WebKit can deliver the committing Enter after compositionend with both
  // composition flags cleared. Its native key timestamp can precede the end event.
  // Keep the grace input-local and bounded so a missed blur/key-up cannot wedge it.
  return endedAt !== undefined && Math.abs(event.timeStamp - endedAt) < 100;
}
