import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
} from "./restart.js";

describe("restart authorization", () => {
  beforeEach(() => {
    __testing.resetSigusr1State();
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __testing.resetSigusr1State();
  });

  it("consumes a scheduled authorization once", async () => {
    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

    scheduleGatewaySigusr1Restart({ delayMs: 0 });

    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

    await vi.runAllTimersAsync();
  });

  it("tracks external restart policy", () => {
    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
    setGatewaySigusr1RestartPolicy({ allowExternal: true });
    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);
  });
});
