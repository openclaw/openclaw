import { expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  beginSessionPermissionChange,
  isSessionPermissionChangePending,
} from "./session-permission-change.js";

it.each(["close", "restart"] as const)(
  "retires pending permission display on %s without clearing a successor",
  async (event) => {
    const sessionId = `permission-display-${event}`;
    const finishPrevious = beginSessionPermissionChange(sessionId);
    expect(isSessionPermissionChangePending(sessionId)).toBe(true);

    await drainGlobalSingletonLifecycleState(event);
    expect(isSessionPermissionChangePending(sessionId)).toBe(false);

    const finishCurrent = beginSessionPermissionChange(sessionId);
    try {
      finishPrevious();
      expect(isSessionPermissionChangePending(sessionId)).toBe(true);
    } finally {
      finishCurrent();
    }
    expect(isSessionPermissionChangePending(sessionId)).toBe(false);
  },
);
