import type { RuntimeConfigState } from "./config-state-model.ts";

/**
 * The form autosave's debounce and its trailing write behind another one. State mirrors
 * whether either is queued, so the save status says "Saving…" only while a save is coming.
 */
export function createConfigAutoSaveSchedule(
  state: RuntimeConfigState,
  delayMs: number,
  publish: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trailing = false;
  const sync = () => {
    const scheduled = timer !== null || trailing;
    if (state.configAutoSaveScheduled !== scheduled) {
      state.configAutoSaveScheduled = scheduled;
      // A blocked autosave clears this outside any write that would publish it.
      queueMicrotask(publish);
    }
  };
  return {
    get timerPending() {
      return timer !== null;
    },
    get trailing() {
      return trailing;
    },
    start(run: () => void) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        run();
        sync();
      }, delayMs);
      sync();
    },
    /** Stops the debounce; true when one was waiting. */
    stopTimer(): boolean {
      if (!timer) {
        return false;
      }
      clearTimeout(timer);
      timer = null;
      sync();
      return true;
    },
    setTrailing(next: boolean) {
      trailing = next;
      sync();
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      trailing = false;
      sync();
    },
  };
}
