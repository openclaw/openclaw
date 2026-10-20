import type { SessionsPatchMutation } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { SESSION_COMMUNICATION_MODES } from "../../../packages/gateway-protocol/src/session-communication.js";

export type SessionCommunicationMenuAction = {
  kind: "set-communication";
  communication: NonNullable<SessionsPatchMutation["communication"]> | null;
};

export function selectSessionCommunication(
  value: string,
  runAction: (action: SessionCommunicationMenuAction) => void,
): boolean {
  if (value === "communication:reset") {
    runAction({ kind: "set-communication", communication: null });
    return true;
  }
  if (!value.startsWith("communication:")) {
    return false;
  }
  const [, direction, selected] = value.split(":");
  const mode = SESSION_COMMUNICATION_MODES.find((candidate) => candidate === selected);
  if ((direction === "send" || direction === "receive") && mode) {
    runAction({ kind: "set-communication", communication: { [direction]: mode } });
  }
  return true;
}
