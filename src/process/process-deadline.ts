/** Let pending child exit and output notifications run before accepting a deadline. */
export function setProcessTimeout(callback: () => void, delayMs: number) {
  let decision: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    // An overdue timer can precede the poll phase that reaps an already-exited child.
    decision = setTimeout(callback, 0);
  }, delayMs);
  return {
    clear() {
      clearTimeout(timer);
      clearTimeout(decision);
    },
    refresh() {
      clearTimeout(decision);
      decision = undefined;
      timer.refresh();
    },
  };
}
