import { expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  beginSessionPermissionChange,
  isSessionPermissionChangePending,
} from "./session-permission-change.js";

it.each(["close", "restart"] as const)(
  "retires pending permission display on %s without letting old completion clear its successor",
  async (event) => {
    const sessionId = `permission-display-${event}`;
    const finish = beginSessionPermissionChange(sessionId);
    let finishSuccessor: (() => void) | undefined;
    try {
      expect(isSessionPermissionChangePending(sessionId)).toBe(true);
      await drainGlobalSingletonLifecycleState(event);
      expect(isSessionPermissionChangePending(sessionId)).toBe(false);

      finishSuccessor = beginSessionPermissionChange(sessionId);
      finish();
      expect(isSessionPermissionChangePending(sessionId)).toBe(true);
      finishSuccessor();
      expect(isSessionPermissionChangePending(sessionId)).toBe(false);
    } finally {
      finish();
      finishSuccessor?.();
    }
  },
);
