import { interruptReplyRunTarget } from "../../sessions/session-controller.js";
import { captureCurrentSessionRunInterruptTarget } from "../../sessions/session-controller.stop-runtime.js";

/** Request Stop through the production controller contract for the current session owner. */
export async function requestCurrentSessionStop(sessionKey: string): Promise<boolean> {
  const target = captureCurrentSessionRunInterruptTarget(sessionKey);
  if (!target) {
    return false;
  }
  return (await interruptReplyRunTarget(target, null)).aborted;
}
