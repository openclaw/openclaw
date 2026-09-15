export const PROGRESS_DISCLOSURE = {
  gestures: 2,
  distancePx: 320,
  reopenedGestures: 3,
  reopenedDistancePx: 640,
  pinnedAfterReopens: 2,
  gesturePauseMs: 200,
  touchGesturePx: 24,
  scrollSettleMs: 300,
} as const;

export type ProgressDisclosureState = Readonly<{
  open: boolean;
  manualOpen: boolean | undefined;
  manualReopens: number;
  activeRunId: string | null;
  completedRunId: string | null;
  readingHistory: boolean;
  gestures: number;
  distancePx: number;
}>;

export type ProgressDisclosureEvent =
  | {
      type: "mount";
      open: boolean;
      manualOpen?: boolean;
      activeRunId: string | null;
      completedRunId: string | null;
      readingHistory: boolean;
    }
  | { type: "run"; runId: string; open: boolean }
  | { type: "complete"; runId: string }
  | { type: "history"; readingHistory: boolean }
  | { type: "gesture"; distancePx: number; newGesture: boolean }
  | { type: "settle" }
  | { type: "click"; open: boolean };

const INITIAL_STATE: ProgressDisclosureState = {
  open: false,
  manualOpen: undefined,
  manualReopens: 0,
  activeRunId: null,
  completedRunId: null,
  readingHistory: false,
  gestures: 0,
  distancePx: 0,
};

export function resolveProgressDisclosure(
  previous: ProgressDisclosureState | undefined,
  event: ProgressDisclosureEvent,
): ProgressDisclosureState {
  const state = previous ?? INITIAL_STATE;
  switch (event.type) {
    case "mount":
      return {
        ...INITIAL_STATE,
        open: event.manualOpen ?? event.open,
        manualOpen: event.manualOpen,
        activeRunId: event.activeRunId,
        completedRunId: event.completedRunId,
        readingHistory: event.readingHistory,
      };
    case "run":
      return event.runId === state.activeRunId
        ? state
        : {
            ...state,
            activeRunId: event.runId,
            completedRunId: null,
            open: state.manualOpen ?? event.open,
            manualReopens: 0,
            gestures: 0,
            distancePx: 0,
          };
    case "complete":
      return event.runId !== state.activeRunId || event.runId === state.completedRunId
        ? state
        : {
            ...state,
            completedRunId: event.runId,
            open: state.manualOpen ?? (state.readingHistory ? state.open : true),
          };
    case "history":
      return {
        ...state,
        readingHistory: event.readingHistory,
        gestures: event.readingHistory ? state.gestures : 0,
        distancePx: event.readingHistory ? state.distancePx : 0,
      };
    case "gesture":
      return {
        ...state,
        gestures: state.gestures + Number(event.newGesture),
        distancePx: state.distancePx + event.distancePx,
      };
    case "settle": {
      if (!state.readingHistory) {
        return { ...state, gestures: 0, distancePx: 0 };
      }
      const reopened = state.manualReopens > 0;
      if (
        !state.open ||
        state.manualOpen === false ||
        state.manualReopens >= PROGRESS_DISCLOSURE.pinnedAfterReopens ||
        state.gestures <
          (reopened ? PROGRESS_DISCLOSURE.reopenedGestures : PROGRESS_DISCLOSURE.gestures) ||
        state.distancePx <
          (reopened ? PROGRESS_DISCLOSURE.reopenedDistancePx : PROGRESS_DISCLOSURE.distancePx)
      ) {
        return state;
      }
      return { ...state, open: false, manualOpen: undefined, gestures: 0, distancePx: 0 };
    }
    case "click":
      return {
        ...state,
        open: event.open,
        manualOpen: event.open,
        manualReopens: state.manualReopens + Number(event.open),
        gestures: 0,
        distancePx: 0,
      };
  }
  const unreachable: never = event;
  return unreachable;
}
