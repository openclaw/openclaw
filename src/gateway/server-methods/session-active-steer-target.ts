import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { captureReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.state.js";

/** Read only the exact physical controller owner, never a catalog projection or successor. */
export function captureSessionActiveSteerTarget(session: {
  storePath: string;
  sessionKey: string;
  agentId: string;
  sessionId: string;
}) {
  const operation = getSessionControllerOperation(
    session.sessionKey,
    captureSessionTarget({
      storeScope: session.storePath,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      incarnation: session.sessionId,
    }),
  );
  return operation?.sessionId === session.sessionId
    ? captureReplyMessageInjectionTarget(operation)
    : undefined;
}
