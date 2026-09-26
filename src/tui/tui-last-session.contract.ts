export const TUI_LAST_SESSION_STATE_KEY_PREFIX = "tui.lastSession.";

export type TuiLastSessionWorkerOperations = {
  "tui.lastSession.write": { input: { stateKey: string; sessionKey: string }; output: void };
  "tui.lastSession.clear": {
    input: { stateKeys: string[]; retiredSessionKeys: string[] };
    output: number;
  };
};
