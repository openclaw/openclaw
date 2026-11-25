import { createDeferred } from "../../test/helpers/promise.js";
import { reserveSessionControllerSource } from "./session-controller.mailbox.js";
import { captureSessionTarget, type SessionTarget } from "./session-controller.target.js";

export function controllerTarget(storeScope: string, sessionKey: string, incarnation?: string) {
  return captureSessionTarget({ storeScope, sessionKey, incarnation });
}

export function controllerSource(
  target: SessionTarget,
  options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
) {
  return reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
    ...options,
  });
}

export function controllerTurn(target: SessionTarget, materialize = true) {
  return {
    target,
    sessionKey: target.sessionKey,
    ...(materialize ? { sessionId: target.incarnation } : {}),
  };
}

export function controllerGate(onEnter?: () => void) {
  const [entered, release] = [createDeferred(), createDeferred()];
  return {
    entered: entered.promise,
    release: release.resolve,
    run: async () => {
      onEnter?.();
      entered.resolve();
      await release.promise;
    },
  };
}
