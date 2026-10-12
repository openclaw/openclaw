import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const TUI_LAST_SESSION_STATE_KEY_PREFIX = "tui.lastSession.";

export type TuiLastSessionReadCommand = { type: "tui.lastSession.read"; stateKey: string };

export function isTuiLastSessionReadCommand(value: unknown): value is TuiLastSessionReadCommand {
  return (
    isRecord(value) && value.type === "tui.lastSession.read" && typeof value.stateKey === "string"
  );
}

export type TuiLastSessionWorkerOperations = {
  "tui.lastSession.write": { input: { stateKey: string; sessionKey: string }; output: void };
  "tui.lastSession.clear": {
    input: { retiredSessionKeys: string[] };
    output: number;
  };
};
