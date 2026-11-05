// Short enough that a multi-tool turn is never silent, long enough that a
// quick answer posts no draft at all: the gate only creates the draft when the
// timer fires, and finalize cancels it.
const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;

export function createChannelProgressDraftGate(params: {
  onStart: () => void | Promise<void>;
  /** Delay after the first work event before a draft starts. */
  initialDelayMs?: number;
  /** Reports timer-fired startup failures, which have no awaiting caller. */
  onStartError?: (error: unknown) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const initialDelayMs = params.initialDelayMs ?? DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  // Timer starts have no awaiting caller, so preserve observability at this SDK boundary.
  const reportStartError =
    params.onStartError ??
    ((error: unknown) => {
      console.warn(`[progress-draft] channel progress draft failed to start: ${String(error)}`);
    });
  type GateState =
    | { kind: "idle" }
    | { kind: "scheduled"; timer?: ReturnType<typeof setTimeout> }
    | { kind: "starting"; promise: Promise<void> }
    | { kind: "started" }
    | { kind: "disposed" };
  let state: GateState = { kind: "idle" };
  let workEvents = 0;

  const transition = (next: GateState) => {
    if (state.kind === "scheduled" && state.timer) {
      clearTimeoutFn(state.timer);
    }
    state = next;
  };

  const start = (): Promise<void> => {
    if (state.kind === "starting") {
      return state.promise;
    }
    if (state.kind === "started" || state.kind === "disposed") {
      return Promise.resolve();
    }
    // cancel/reset abandon an in-flight onStart; when it settles it must not touch
    // the state that replaced it.
    const attempt: Extract<GateState, { kind: "starting" }> = {
      kind: "starting",
      promise: Promise.resolve()
        .then(params.onStart)
        .then(
          () => {
            if (state === attempt) {
              state = { kind: "started" };
            }
          },
          (error: unknown) => {
            if (state === attempt) {
              state = { kind: "idle" };
            }
            throw error;
          },
        ),
    };
    transition(attempt);
    return attempt.promise;
  };

  const hasStarted = () => state.kind === "starting" || state.kind === "started";

  const schedule = () => {
    if (state.kind !== "idle" || initialDelayMs < 0) {
      return;
    }
    // Enter scheduled before arming: injected timer functions may fire synchronously.
    const scheduled: Extract<GateState, { kind: "scheduled" }> = { kind: "scheduled" };
    state = scheduled;
    scheduled.timer = setTimeoutFn(() => {
      if (state !== scheduled) {
        return;
      }
      state = { kind: "idle" };
      // Explicit starts rethrow to callers; timer starts must report at the boundary.
      void start().catch((error: unknown) => {
        reportStartError(error);
      });
    }, initialDelayMs);
  };

  return {
    get hasStarted() {
      return hasStarted();
    },
    get workEvents() {
      return workEvents;
    },
    async noteWork(): Promise<boolean> {
      if (state.kind === "disposed") {
        return false;
      }
      workEvents += 1;
      if (state.kind === "starting") {
        await state.promise;
        return hasStarted();
      }
      if (state.kind === "started") {
        return true;
      }
      schedule();
      return false;
    },
    async startNow(): Promise<void> {
      await start();
    },
    cancel(): void {
      transition({ kind: "disposed" });
    },
    reset(): void {
      transition({ kind: "idle" });
      workEvents = 0;
    },
  };
}
