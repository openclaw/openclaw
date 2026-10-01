import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const TUI_LAST_SESSION_STATE_KEY_PREFIX = "tui.lastSession.";

export type TuiLastSessionReadCommand =
  | { type: "tui.lastSession.read"; stateKey: string }
  | { type: "tui.lastSession.retiredPointers"; retiredSessionKeys: string[] };

export function isTuiLastSessionReadCommand(value: unknown): value is TuiLastSessionReadCommand {
  return (
    isRecord(value) &&
    ((value.type === "tui.lastSession.read" && typeof value.stateKey === "string") ||
      (value.type === "tui.lastSession.retiredPointers" &&
        Array.isArray(value.retiredSessionKeys) &&
        value.retiredSessionKeys.every((key) => typeof key === "string")))
  );
}

export type TuiLastSessionWorkerOperations = {
  "tui.lastSession.write": { input: { stateKey: string; sessionKey: string }; output: void };
  "tui.lastSession.clear": {
    input: { stateKeys: string[]; retiredSessionKeys: string[] };
    output: number;
  };
};
