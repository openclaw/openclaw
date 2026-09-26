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

type ProgressDisclosureChoice = boolean | number;

export type ProgressDisclosureState = Readonly<{
  open: boolean;
  manualOpen: ProgressDisclosureChoice | undefined;
  manualReopens: number;
  readingHistory: boolean;
  gestures: number;
  distancePx: number;
}>;

export type ProgressDisclosureEvent =
  | {
      type: "mount";
      open: boolean;
      manualOpen?: ProgressDisclosureChoice;
      readingHistory: boolean;
    }
  | { type: "history"; readingHistory: boolean }
  | { type: "gesture"; distancePx: number }
  | { type: "settle" }
  | { type: "takeover" }
  | { type: "extent"; extent: number }
  | { type: "clamp"; limit: number }
  | { type: "click"; open: boolean };

const INITIAL_STATE: ProgressDisclosureState = {
  open: false,
  manualOpen: undefined,
  manualReopens: 0,
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
        open: event.manualOpen === undefined ? event.open : Boolean(event.manualOpen),
        manualOpen: event.manualOpen,
        readingHistory: event.readingHistory,
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
        gestures: state.gestures + 1,
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
    case "takeover":
      return { ...state, gestures: 0, distancePx: 0 };
    case "extent":
      return {
        ...state,
        open: event.extent > 0,
        manualOpen: event.extent === 0 ? false : event.extent,
        manualReopens: state.manualReopens + Number(!state.open && event.extent > 0),
        gestures: 0,
        distancePx: 0,
      };
    case "clamp":
      return typeof state.manualOpen === "number" && state.manualOpen > event.limit
        ? { ...state, manualOpen: event.limit, open: event.limit > 0 }
        : state;
    case "click":
      return {
        ...state,
        open: event.open,
        manualOpen: event.open,
        manualReopens: state.manualReopens + Number(!state.open && event.open),
        gestures: 0,
        distancePx: 0,
      };
  }
  const unreachable: never = event;
  return unreachable;
}
