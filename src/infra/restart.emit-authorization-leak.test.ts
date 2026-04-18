// Regression: emitGatewayRestart's catch block rolls back only
// emittedRestartToken and leaves the sigusr1 authorization count incremented.
//
// Sequence:
//   1. emitGatewayRestart() calls authorizeGatewaySigusr1Restart(), which
//      increments sigusr1AuthorizedCount.
//   2. process.emit / process.kill throws.
//   3. The catch block rolls back emittedRestartToken but not the
//      authorization count.
//   4. consumeGatewaySigusr1RestartAuthorization() returns true for a stray
//      (already-failed) restart cycle, until SIGUSR1_AUTH_GRACE_MS (5 s)
//      self-expires the bucket.
//
// Expected after fix: the catch path reverses the authorization increment so
// the leak window closes immediately instead of ~5 s later.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  emitGatewayRestart,
} from "./restart.js";

describe("emitGatewayRestart rolls back authorization when emission throws", () => {
  beforeEach(() => {
    __testing.resetSigusr1State();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __testing.resetSigusr1State();
  });

  it("does not leave an unconsumed authorization when process.kill throws", () => {
    // No SIGUSR1 listener, so emitGatewayRestart falls through to process.kill.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("simulated kill failure");
    });

    expect(emitGatewayRestart()).toBe(false);
    expect(killSpy).toHaveBeenCalledTimes(1);

    // The emission failed, so nothing should be able to claim a "valid"
    // sigusr1 authorization from that aborted cycle.
    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
  });
});
